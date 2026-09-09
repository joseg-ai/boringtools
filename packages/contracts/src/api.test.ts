import { describe, expect, it } from 'vitest';
import { LIVE_TOOL_IDS } from '@domos/catalog';
import {
  API_ERROR_HTTP_STATUS, API_ROUTES, apiOriginSchema, apiRequestSchemas, apiResponseSchemas,
  dnsOutcomeSchema, healthReportSchema, httpReportSchema, LIMITS,
  LIVE_TOOL_OPERATIONS, type ApiError, type EmailPolicyReport, type ReportMeta,
} from './index.js';

const meta: ReportMeta = {
  requestId: 'fixture-1', observedAt: '2026-09-08T15:43:04.742Z',
  elapsedMs: 12, policyVersion: 'domos-v1',
};
const failure: ApiError = { code: 'TIMEOUT', phase: 'dns', message: 'Resolver deadline exceeded' };

describe('live API contracts', () => {
  it('maps exactly three live tools to explicit cross-origin API routes', () => {
    expect(Object.keys(LIVE_TOOL_OPERATIONS)).toEqual([...LIVE_TOOL_IDS]);
    expect(API_ROUTES).toEqual({
      dns: '/api/v1/dns', emailPolicy: '/api/v1/email-policy', http: '/api/v1/http',
    });
    expect(apiRequestSchemas.http.parse({ url: 'https://example.com' })).toEqual({
      url: 'https://example.com', method: 'HEAD',
    });
  });

  it('strictly validates all three request shapes', () => {
    const requests = {
      dns: { name: 'example.com', types: ['A', 'TXT'] },
      emailPolicy: { domain: 'example.com', dkimSelector: 'mail' },
      http: { url: 'https://example.com', method: 'HEAD' },
    };
    for (const operation of ['dns', 'emailPolicy', 'http'] as const) {
      expect(apiRequestSchemas[operation].safeParse(requests[operation]).success).toBe(true);
      expect(apiRequestSchemas[operation].safeParse({ ...requests[operation], headers: {} }).success).toBe(false);
    }
    expect(apiRequestSchemas.dns.safeParse({ name: '_dmarc.example.com', types: ['TXT'] }).success).toBe(true);
    expect(apiRequestSchemas.dns.safeParse({ name: '2001:4860:4860::8888', types: ['PTR'] }).success).toBe(true);
    expect(apiRequestSchemas.dns.safeParse({ name: 'a'.repeat(64) + '.com', types: ['A'] }).success).toBe(false);
    expect(apiRequestSchemas.dns.safeParse({ name: 'example.com', types: ['A', 'A'] }).success).toBe(false);
    expect(apiRequestSchemas.dns.safeParse({ name: 'example.com', types: [] }).success).toBe(false);
    expect(apiRequestSchemas.http.safeParse({ url: 'ftp://example.com', method: 'HEAD' }).success).toBe(false);
    expect(apiRequestSchemas.http.safeParse({ url: 'https://example.com', method: 'POST' }).success).toBe(false);
  });

  it('accepts only a fixed configured API origin, not paths or arbitrary HTTP hosts', () => {
    for (const origin of ['https://api.domosdigial.com', 'http://localhost:8787']) {
      expect(apiOriginSchema.safeParse(origin).success).toBe(true);
    }
    for (const origin of [
      'https://api.domosdigial.com/', 'https://api.domosdigial.com/api',
      'http://example.com', 'https://user:password@example.com', '/api',
    ]) {
      expect(apiOriginSchema.safeParse(origin).success).toBe(false);
    }
  });

  it('keeps NXDOMAIN and NODATA as successful observations, not service failures', () => {
    for (const outcome of [
      { type: 'A', status: 'negative', reason: 'NXDOMAIN', rcode: 3 },
      { type: 'TXT', status: 'negative', reason: 'NODATA', rcode: 0 },
    ]) {
      expect(apiResponseSchemas.dns.safeParse({
        kind: 'result', data: { name: 'example.com', resolver: 'fixture', queries: [outcome] }, meta,
      }).success).toBe(true);
    }
    expect(dnsOutcomeSchema.safeParse({ type: 'A', status: 'negative', reason: 'NXDOMAIN', rcode: 0 }).success).toBe(false);
    expect(dnsOutcomeSchema.safeParse({ type: 'A', status: 'negative', reason: 'SERVFAIL', rcode: 2 }).success).toBe(false);
    expect(dnsOutcomeSchema.safeParse({ type: 'A', status: 'error', rcode: 2, error: failure }).success).toBe(true);
  });

  it('preserves TXT chunks, TTL, MX fields and numeric RCODE', () => {
    expect(dnsOutcomeSchema.safeParse({
      type: 'TXT', status: 'answer', rcode: 0,
      records: [{ name: 'example.com', ttl: 300, type: 'TXT', chunks: ['part1', 'part2'] }],
    }).success).toBe(true);
    expect(dnsOutcomeSchema.safeParse({
      type: 'MX', status: 'answer', rcode: 0,
      records: [{ name: 'example.com', ttl: 300, type: 'MX', exchange: 'mail.example.com', preference: 10 }],
    }).success).toBe(true);
    expect(dnsOutcomeSchema.safeParse({
      type: 'TXT', status: 'answer', rcode: 0,
      records: [{ name: 'example.com', ttl: 300, type: 'TXT', chunks: [], injected: true }],
    }).success).toBe(false);
  });

  it('bounds the full serialized response, not just each DNS record', () => {
    expect(apiResponseSchemas.dns.safeParse({
      kind: 'result',
      data: {
        name: 'example.com', resolver: 'fixture',
        queries: [{
          type: 'TXT', status: 'answer', rcode: 0,
          records: [{
            name: 'example.com', ttl: 60, type: 'TXT',
            chunks: Array<string>(64).fill('a'.repeat(4096)),
          }],
        }],
      },
      meta,
    }).success).toBe(false);
  });

  it('requires partial data plus an explicit error and response metadata', () => {
    const data = {
      name: 'example.com', resolver: 'fixture',
      queries: [{ type: 'A', status: 'error', rcode: null, error: failure }],
    };
    expect(apiResponseSchemas.dns.safeParse({ kind: 'partial', data, error: failure, meta }).success).toBe(true);
    expect(apiResponseSchemas.dns.safeParse({ kind: 'partial', data, meta }).success).toBe(false);
    expect(apiResponseSchemas.dns.safeParse({ kind: 'partial', error: failure, meta }).success).toBe(false);
    expect(apiResponseSchemas.dns.safeParse({ kind: 'error', error: failure, meta, data }).success).toBe(false);
    expect(apiResponseSchemas.dns.safeParse({
      kind: 'error', error: failure, meta: { ...meta, rawInput: 'not allowed' },
    }).success).toBe(false);
    expect(API_ERROR_HTTP_STATUS).toMatchObject({
      INVALID_INPUT: 400, TARGET_BLOCKED: 422, RATE_LIMITED: 429,
      UPSTREAM_ERROR: 502, TIMEOUT: 504, LIMIT_EXCEEDED: 413, NOT_READY: 503,
    });
  });

  it('models incomplete SPF, DMARC absence and an unrequested DKIM selector truthfully', () => {
    const data: EmailPolicyReport = {
      domain: 'example.com', organizationalDomain: 'example.com', resolver: 'fixture',
      spf: {
        status: 'indeterminate', owner: 'example.com', records: ['v=spf1 include:example.net -all'],
        findings: [], dependencies: [{ from: 'example.com', to: 'example.net', mechanism: 'include', status: 'unresolved' }],
        lookupCount: 1, complete: false, unevaluated: ['Include lookup timed out; sender context was not evaluated.'],
      },
      dmarc: {
        status: 'absent', owner: '_dmarc.example.com', records: [], findings: [],
        policy: null, organizationalFallback: false,
      },
      dkim: { status: 'not-requested', owner: null, selector: null, records: [], findings: [] },
      evidence: [], queriesUsed: 2, queryBudget: 32,
      limitations: ['DNS observations do not authenticate a message.'],
      evaluationScope: 'dns-records-only', authentication: 'not-verified',
    };
    expect(apiResponseSchemas.emailPolicy.safeParse({ kind: 'partial', data, error: failure, meta }).success).toBe(true);
    expect(apiResponseSchemas.emailPolicy.safeParse({
      kind: 'result', data: { ...data, authentication: 'verified' }, meta,
    }).success).toBe(false);
    expect(apiResponseSchemas.emailPolicy.safeParse({
      kind: 'result', data: { ...data, deliverabilityScore: 100 }, meta,
    }).success).toBe(false);
    expect(apiResponseSchemas.emailPolicy.safeParse({
      kind: 'result', data: { ...data, dkim: { ...data.dkim, status: 'absent' } }, meta,
    }).success).toBe(false);
    expect(apiResponseSchemas.emailPolicy.safeParse({
      kind: 'result', data: { ...data, dmarc: { ...data.dmarc, status: 'present' } }, meta,
    }).success).toBe(false);
  });

  it('bounds HTTP hops and keeps repeated remote headers as data', () => {
    const hop = {
      url: 'https://example.com', method: 'HEAD', remoteAddress: '8.8.8.8', statusCode: 302,
      headers: [{ name: 'set-cookie', value: 'a=1' }, { name: 'set-cookie', value: 'b=2' }],
      durationMs: 12, location: 'https://example.net',
    };
    const data = {
      requestedUrl: 'https://example.com', method: 'HEAD',
      hops: [hop], termination: 'redirect-limit',
    };
    expect(httpReportSchema.safeParse(data).success).toBe(true);
    expect(httpReportSchema.safeParse({ ...data, hops: Array(LIMITS.httpHops + 1).fill(hop) }).success).toBe(false);
    expect(httpReportSchema.safeParse({ ...data, hops: [{ ...hop, body: '<html>not collected</html>' }] }).success).toBe(false);
    expect(httpReportSchema.safeParse({
      ...data,
      hops: [{ ...hop, headers: [
        { name: 'x-a', value: 'a'.repeat(LIMITS.httpHeaderBytes / 2) },
        { name: 'x-b', value: 'b'.repeat(LIMITS.httpHeaderBytes / 2) },
      ] }],
    }).success).toBe(false);
  });

  it('distinguishes healthy from foundation-not-ready probes', () => {
    expect(healthReportSchema.parse({
      service: 'domos-diagnostics', status: 'not-ready', contractVersion: 1,
    }).status).toBe('not-ready');
  });
});
