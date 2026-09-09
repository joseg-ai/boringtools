import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  API_ERROR_HTTP_STATUS, API_ROUTES, CONTRACT_VERSION, HEALTH_PATH, LIMITS,
  apiRequestSchemas, apiResponseSchemas, healthReportSchema, jsonWithinByteLimit,
  type ApiError, type ApiOperation, type ReportMeta,
} from '@domos/contracts';
import { loadConfig, POLICY_VERSION } from './config.js';
import { DnsResolver, inspectDns } from './dns.js';
import { inspectEmail } from './email.js';
import { DiagnosticError, failure, safeError } from './errors.js';
import { inspectHttp } from './http.js';
import { Admission, ConnectionLimiter, RequestBudget } from './limits.js';
import { createPinnedTransport, createWireExchange, type PinnedTransport, type WireExchange } from './network.js';

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  wire?: WireExchange;
  transport?: PinnedTransport;
}

export function buildApp(options: AppOptions = {}) {
  const config = loadConfig(options.env);
  const limiter = new ConnectionLimiter();
  const resolver = new DnsResolver(options.wire ?? createWireExchange(limiter));
  const transport = options.transport ?? createPinnedTransport(limiter);
  const admission = new Admission();
  const app = Fastify({
    logger: false, trustProxy: false,
    bodyLimit: LIMITS.apiBodyBytes, requestIdHeader: false, genReqId: () => randomUUID(),
    requestTimeout: 15_000, connectionTimeout: 15_000, keepAliveTimeout: 5000,
    maxRequestsPerSocket: 100, return503OnClosing: false,
    onProtoPoisoning: 'error', onConstructorPoisoning: 'error',
    http: { maxHeaderSize: LIMITS.httpHeaderBytes },
  });
  app.server.maxConnections = 128;
  app.server.headersTimeout = 10_000;
  const states = new WeakMap<FastifyRequest, {
    started: number; observedAt: string; release: (() => void) | undefined;
  }>();
  const meta = (request: FastifyRequest): ReportMeta => {
    const state = states.get(request);
    return {
      requestId: request.id, observedAt: state?.observedAt ?? new Date().toISOString(),
      elapsedMs: Math.max(0, performance.now() - (state?.started ?? performance.now())),
      policyVersion: POLICY_VERSION,
    };
  };
  const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiError) => {
    if (error.retryAfterSeconds) reply.header('Retry-After', error.retryAfterSeconds);
    return reply.code(API_ERROR_HTTP_STATUS[error.code]).send({ kind: 'error', error, meta: meta(request) });
  };
  const paths = new Set<string>(Object.values(API_ROUTES));
  app.addHook('onRequest', async (request, reply) => {
    const state = { started: performance.now(), observedAt: new Date().toISOString(), release: undefined as (() => void) | undefined };
    states.set(request, state);
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    reply.header('Vary', 'Origin');
    const origin = request.headers.origin;
    if (origin && config.origins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Expose-Headers', 'Retry-After');
    }
    const path = request.url.split('?')[0]!;
    if (path !== HEALTH_PATH || !['GET', 'HEAD'].includes(request.method)) {
      state.release = admission.enter(request.ip);
      reply.raw.once('close', () => state.release?.());
    }
    if (paths.has(path) && request.method === 'POST') {
      const contentType = request.headers['content-type'];
      if (!contentType || !/^application\/json(?:\s*;\s*charset=(?:"utf-8"|utf-8))?\s*$/i.test(contentType)
        || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
        return sendError(request, reply, failure('UNSUPPORTED_MEDIA_TYPE', 'validation'));
      }
      if (request.url.includes('?')) return sendError(request, reply, failure('INVALID_INPUT', 'validation'));
    }
  });
  app.addHook('onResponse', async (request) => { states.get(request)?.release?.(); });
  app.setErrorHandler((error: Error & { code?: string }, request, reply) => {
    const code = error.code;
    const detail = error instanceof DiagnosticError ? error.detail
      : code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? failure('LIMIT_EXCEEDED', 'validation')
        : code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? failure('UNSUPPORTED_MEDIA_TYPE', 'validation')
          : code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_JSON_BODY'
            || code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' || error instanceof SyntaxError
            ? failure('INVALID_INPUT', 'validation') : failure('INTERNAL_ERROR', 'service');
    return sendError(request, reply, detail);
  });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    const known = paths.has(path) || path === HEALTH_PATH;
    if (known) reply.header('Allow', path === HEALTH_PATH ? 'GET, HEAD, OPTIONS' : 'POST, OPTIONS');
    return sendError(request, reply, failure(known ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', 'validation'));
  });
  for (const path of [...paths, HEALTH_PATH]) {
    app.options(path, async (request, reply) => {
      const method = path === HEALTH_PATH ? 'GET' : 'POST';
      const headers = request.headers['access-control-request-headers'];
      if (!request.headers.origin || !config.origins.includes(request.headers.origin)
        || request.headers['access-control-request-method'] !== method
        || (headers && headers.split(',').some((header) => header.trim().toLowerCase() !== 'content-type'))) {
        return sendError(request, reply, failure('TARGET_BLOCKED', 'policy'));
      }
      return reply.header('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers')
        .header('Access-Control-Allow-Methods', method).header('Access-Control-Allow-Headers', 'Content-Type')
        .header('Access-Control-Max-Age', '600').code(204).send();
    });
  }
  app.get(HEALTH_PATH, async () => healthReportSchema.parse({
    service: 'domos-diagnostics', status: 'ok', contractVersion: CONTRACT_VERSION,
  }));
  const timeout: Record<ApiOperation, number> = {
    dns: LIMITS.dnsTimeoutMs, emailPolicy: LIMITS.emailTimeoutMs, http: LIMITS.httpTimeoutMs,
  };
  for (const operation of ['dns', 'emailPolicy', 'http'] as const) {
    app.post(API_ROUTES[operation], async (request, reply) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout[operation]);
      timer.unref();
      const abort = () => controller.abort();
      const close = () => { if (!reply.raw.writableFinished) abort(); };
      request.raw.once('aborted', abort);
      reply.raw.once('close', close);
      const budget = new RequestBudget(controller.signal, operation === 'emailPolicy' ? LIMITS.emailQueries : LIMITS.dnsQueries);
      try {
        const parsed = apiRequestSchemas[operation].safeParse(request.body);
        if (!parsed.success) return sendError(request, reply, failure('INVALID_INPUT', 'validation'));
        // Re-parse at the narrowed operation to preserve request/handler type pairing.
        const result = operation === 'dns'
          ? await inspectDns(apiRequestSchemas.dns.parse(request.body), resolver, budget)
          : operation === 'emailPolicy'
            ? await inspectEmail(apiRequestSchemas.emailPolicy.parse(request.body), resolver, budget)
            : await inspectHttp(apiRequestSchemas.http.parse(request.body), resolver, transport, budget, config.deniedHosts);
        const payload = {
          kind: result.error ? 'partial' : 'result', data: result.data,
          ...(result.error ? { error: result.error } : {}), meta: meta(request),
        };
        if (!jsonWithinByteLimit(payload, LIMITS.apiResponseBytes)) {
          return sendError(request, reply, failure('LIMIT_EXCEEDED', 'service'));
        }
        const validated = apiResponseSchemas[operation].safeParse(payload);
        if (!validated.success) return sendError(request, reply, failure('INTERNAL_ERROR', 'service'));
        if (result.error?.retryAfterSeconds) reply.header('Retry-After', result.error.retryAfterSeconds);
        return reply.send(validated.data);
      } catch (error) {
        return sendError(request, reply, safeError(error, 'service', controller.signal));
      } finally {
        clearTimeout(timer);
        request.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', close);
      }
    });
  }
  return app;
}
