import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_ROUTES, LIMITS, apiResponseSchemas, healthReportSchema, type ApiOperation,
} from '@domos/contracts';
import { buildApp } from './app.js';
import { SERVICE_LIMITS } from './config.js';
import { answer, headersTransport, publicDns, wireFixture } from './fixtures.test-support.js';

const apps: ReturnType<typeof buildApp>[] = [];
function app(options: Parameters<typeof buildApp>[0] = {}) {
  const value = buildApp({ env: {}, wire: publicDns, transport: headersTransport, ...options });
  apps.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((value) => value.close()));
  vi.useRealTimers();
});

describe('diagnostics routes', () => {
  it('is ready with valid configuration and implements all frozen contracts', async () => {
    const server = app();
    const health = await server.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(healthReportSchema.parse(health.json()).status).toBe('ok');
    for (const [operation, payload] of [
      ['dns', { name: 'example.com', types: ['A'] }],
      ['emailPolicy', { domain: 'example.com' }],
      ['http', { url: 'https://example.com' }],
    ] as const) {
      const result = await server.inject({ method: 'POST', url: API_ROUTES[operation], payload });
      expect(result.statusCode).toBe(200);
      expect(apiResponseSchemas[operation].parse(result.json()).kind).toBe('result');
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['set-cookie']).toBeUndefined();
    }
  });

  it('fails startup for invalid origins, ports and unresolved proxy trust', () => {
    for (const env of [
      { CORS_ORIGINS: '*' }, { CORS_ORIGINS: 'https://tools.domosdigial.com/' },
      { PORT: '0' }, { TRUST_PROXY: 'true' }, { TRUST_PROXY: '10.0.0.0/8' },
      { NODE_ENV: 'production', CORS_ORIGINS: 'http://localhost:4322' },
      { PUBLIC_SITE_ORIGIN: 'https://example.com/path' },
      { NODE_ENV: 'production', PUBLIC_SITE_ORIGIN: 'http://localhost:4321' },
    ]) expect(() => buildApp({ env })).toThrow('Invalid diagnostics service configuration.');
  });

  it('denies all generated preview hosts as diagnostic targets', async () => {
    const origins = ['https://api.example.eastus2.azurecontainerapps.io', 'https://site-example.azurestaticapps.net', 'https://tools-example.azurestaticapps.net'];
    const server = app({ env: {
      NODE_ENV: 'production', PUBLIC_API_ORIGIN: origins[0],
      PUBLIC_SITE_ORIGIN: origins[1], CORS_ORIGINS: origins[2],
    } });
    for (const url of origins) {
      const result = await server.inject({ method: 'POST', url: API_ROUTES.http, payload: { url } });
      expect(result.statusCode).toBe(422);
      expect(result.json().error.code).toBe('TARGET_BLOCKED');
    }
  });

  it('rejects unknown fields and malformed requests without reflecting submitted content', async () => {
    const server = app();
    const secret = 'private-secret-header-value';
    for (const [operation, payload] of [
      ['dns', { name: secret, types: ['NOPE'], [secret]: secret }],
      ['emailPolicy', { domain: 'example.com', headers: { [secret]: secret } }],
      ['http', { url: 'https://example.com', method: 'POST', headers: { [secret]: secret } }],
    ] as const) {
      const result = await server.inject({ method: 'POST', url: API_ROUTES[operation], payload });
      expect(result.statusCode).toBe(400);
      expect(apiResponseSchemas[operation].parse(result.json()).kind).toBe('error');
      expect(result.body).not.toContain(secret);
    }
    for (const payload of ['{"secret":', '', '{"__proto__":{"secret":true}}']) {
      const result = await server.inject({
        method: 'POST', url: API_ROUTES.dns, headers: { 'content-type': 'application/json' }, payload,
      });
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain('secret');
    }
  });

  it('bounds bodies and enforces JSON UTF-8 without echoes', async () => {
    const server = app();
    for (const headers of [
      { 'content-type': 'text/plain' }, { 'content-type': 'application/json; charset=latin1' },
      { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    ]) {
      const result = await server.inject({ method: 'POST', url: API_ROUTES.dns, payload: '{}', headers });
      expect(result.statusCode).toBe(415);
      expect(apiResponseSchemas.dns.parse(result.json()).kind).toBe('error');
    }
    const result = await server.inject({
      method: 'POST', url: API_ROUTES.dns, payload: { name: 's'.repeat(LIMITS.apiBodyBytes), types: ['A'] },
    });
    expect(result.statusCode).toBe(413);
    expect(result.body.length).toBeLessThan(1000);
  });

  it('returns structured not-found/method failures, not reflected URLs', async () => {
    const server = app();
    for (const [url, method, expected] of [
      ['/secret-path', 'GET', 404], [API_ROUTES.dns, 'GET', 405],
      [API_ROUTES.http, 'PUT', 405], ['/healthz', 'POST', 405],
    ] as const) {
      const result = await server.inject({ url, method });
      expect(result.statusCode).toBe(expected);
      expect(apiResponseSchemas.http.parse(result.json()).kind).toBe('error');
      expect(result.body).not.toContain('secret-path');
      if (expected === 405) expect(result.headers.allow).toBeTruthy();
    }
  });

  it('uses exact CORS origins, with no credentials; non-browser callers remain possible', async () => {
    const server = app({ env: { NODE_ENV: 'production', CORS_ORIGINS: 'https://tools.domosdigial.com' } });
    for (const origin of [
      'https://tools.domosdigial.com', 'https://tools.domosdigial.com.evil.net', 'null', 'http://localhost:4322',
    ]) {
      const result = await server.inject({
        method: 'POST', url: API_ROUTES.dns, headers: { origin }, payload: { name: 'example.com', types: ['A'] },
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers['access-control-allow-origin']).toBe(origin === 'https://tools.domosdigial.com' ? origin : undefined);
      expect(result.headers['access-control-allow-credentials']).toBeUndefined();
    }
    const preflight = await server.inject({
      method: 'OPTIONS', url: API_ROUTES.http, headers: {
        origin: 'https://tools.domosdigial.com', 'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    const forbidden = await server.inject({
      method: 'OPTIONS', url: API_ROUTES.http, headers: {
        origin: 'https://tools.domosdigial.com', 'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(forbidden.statusCode).toBe(422);
  });

  it('does not let forged forwarded IPs evade per-source rate limits', async () => {
    const server = app();
    for (let index = 0; index < SERVICE_LIMITS.requestsPerIpMinute; index++) {
      const result = await server.inject({
        method: 'GET', url: '/not-found',
        headers: { 'x-forwarded-for': `8.8.8.${index}`, forwarded: `for=1.1.1.${index}` },
      });
      expect(result.statusCode).toBe(404);
    }
    const result = await server.inject({
      method: 'POST', url: API_ROUTES.dns, headers: { 'x-forwarded-for': '1.1.1.1' },
      payload: { name: 'example.com', types: ['A'] },
    });
    expect(result.statusCode).toBe(429);
    expect(result.headers['retry-after']).toBe('60');
    expect(apiResponseSchemas.dns.parse(result.json())).toMatchObject({ kind: 'error', error: { code: 'RATE_LIMITED' } });
    expect((await server.inject('/healthz')).statusCode).toBe(200);
  });

  it('bounds request concurrency before parsing or doing outbound work', async () => {
    let started = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const server = app({ wire: async (body, signal) => { started++; await wait; return publicDns(body, signal); } });
    const pending = Array.from({ length: SERVICE_LIMITS.concurrentRequests }, () => server.inject({
      method: 'POST', url: API_ROUTES.dns, payload: { name: 'example.com', types: ['A'] },
    }).then((result) => result));
    await vi.waitFor(() => expect(started).toBe(SERVICE_LIMITS.concurrentRequests));
    const rejected = await server.inject({
      method: 'POST', url: API_ROUTES.dns, payload: { name: 'example.com', types: ['A'] },
    });
    expect(rejected.statusCode).toBe(429);
    release();
    expect((await Promise.all(pending)).every((result) => result.statusCode === 200)).toBe(true);
  });

  it('uses a server-generated request ID and fixed upstream errors without logging inputs', async () => {
    const log = vi.spyOn(console, 'log');
    const errorLog = vi.spyOn(console, 'error');
    const secret = 'private-secret.invalid';
    const server = app({ wire: async () => { throw new Error(`Response from ${secret} with Authorization: token`); } });
    const result = await server.inject({
      method: 'POST', url: API_ROUTES.dns, headers: { 'x-request-id': secret },
      payload: { name: 'example.com', types: ['A'] },
    });
    expect(result.statusCode).toBe(502);
    expect(apiResponseSchemas.dns.safeParse(result.json()).success).toBe(true);
    expect(result.body).not.toContain(secret);
    expect(result.body).not.toContain('Authorization');
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('propagates the absolute HTTP deadline to a stalled transport and returns a typed 504', async () => {
    let started = false;
    const server = app({
      transport: async (_target, _address, _method, signal) => new Promise((_resolve, reject) => {
        started = true;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    await server.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = server.inject({
      method: 'POST', url: API_ROUTES.http, payload: { url: 'https://example.com' },
    }).then((result) => result);
    await vi.waitFor(() => expect(started).toBe(true));
    await vi.advanceTimersByTimeAsync(LIMITS.httpTimeoutMs);
    const result = await pending;
    expect(result.statusCode).toBe(504);
    expect(apiResponseSchemas.http.parse(result.json())).toMatchObject({ kind: 'error', error: { code: 'TIMEOUT' } });
  });

  it('enforces the serialized response budget rather than individual record caps only', async () => {
    const large = wireFixture((name) => ({
      answers: Array.from({ length: 30 }, () => ({
        type: 'TXT' as const, name, ttl: 1, class: 'IN' as const,
        data: Array.from({ length: 6 }, () => Buffer.alloc(255, 65)),
      })),
    }));
    const server = app({ wire: large });
    const result = await server.inject({
      method: 'POST', url: API_ROUTES.dns,
      payload: { name: 'example.com', types: ['A', 'AAAA', 'MX', 'NS', 'SOA', 'TXT', 'CNAME', 'PTR'] },
    });
    expect(result.statusCode).toBe(413);
    expect(result.body.length).toBeLessThan(1000);
  });

  it.each<ApiOperation>(['dns', 'emailPolicy', 'http'])('rejects non-public input for %s', async (operation) => {
    const wire = vi.fn(publicDns);
    const server = app({ wire });
    const payload = operation === 'dns' ? { name: 'internal.local', types: ['A'] }
      : operation === 'emailPolicy' ? { domain: 'internal.local' } : { url: 'https://127.0.0.1' };
    const result = await server.inject({ method: 'POST', url: API_ROUTES[operation], payload });
    expect(result.statusCode).toBe(422);
    expect(apiResponseSchemas[operation].parse(result.json()).kind).toBe('error');
    expect(wire).not.toHaveBeenCalled();
  });

  it('returns typed partial evidence when one DNS type fails', async () => {
    const server = app({ wire: wireFixture((name, type) => type === 'A'
      ? { answers: [answer('A', name, '10.0.0.1')] } : { rcode: 2 }) });
    const result = await server.inject({
      method: 'POST', url: API_ROUTES.dns, payload: { name: 'example.com', types: ['A', 'AAAA'] },
    });
    expect(result.statusCode).toBe(200);
    expect(apiResponseSchemas.dns.parse(result.json())).toMatchObject({
      kind: 'partial', data: { queries: [
        { status: 'answer', records: [{ address: '10.0.0.1' }] }, { status: 'error', rcode: 2 },
      ] },
    });
  });
});
