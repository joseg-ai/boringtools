import { API_ROUTES, apiResponseSchemas, type ApiOperation } from '@domos/contracts';
import { buildApp } from '../../../apps/diagnostics/src/app';
import { DiagnosticError } from '../../../apps/diagnostics/src/errors';
import { answer, wireFixture, redirectHeaders } from '../../../apps/diagnostics/src/fixtures.test-support';
import { test as browserTest, origins } from './browser';

export function fixtureApi() {
  const calls: string[] = [];
  const server = buildApp({
    env: { NODE_ENV: 'test', CORS_ORIGINS: origins.workspace },
    wire: wireFixture((name, type) => {
      calls.push(`dns:${name}:${type}`);
      if (name.startsWith('nx.')) return { rcode: 3 };
      if (name.startsWith('fail.') || name.startsWith('broken.')) return { rcode: 2 };
      if (name === 'mail.example.com' && type === 'TXT') {
        return { answers: [answer('TXT', name, 'v=spf1 include:broken.example.com -all')] };
      }
      if (name === '_dmarc.mail.example.com' && type === 'TXT') {
        return { answers: [answer('TXT', name, 'v=DMARC1; p=reject')] };
      }
      return { answers: type === 'A' ? [answer('A', name, '8.8.8.8')] : [] };
    }),
    transport: async (target, address, method) => {
      calls.push(`http:${method}:${target.url.pathname}:${address}`);
      if (target.url.pathname === '/error') throw new Error('QA_SYNTHETIC_TRANSPORT_SENTINEL');
      if (target.url.pathname === '/upstream') throw new DiagnosticError('UPSTREAM_ERROR', 'tls');
      return {
        remoteAddress: address,
        statusCode: target.url.pathname === '/redirect' || target.url.pathname === '/blocked' ? 302 : 200,
        headers: target.url.pathname === '/redirect' ? redirectHeaders('/final')
          : target.url.pathname === '/blocked' ? redirectHeaders('http://127.0.0.1/')
            : [{ name: 'x-fixture', value: 'synthetic-only' }, { name: 'x-fixture', value: '<b>inert</b>' }],
      };
    },
  });
  return { server, calls, requests: [] as ApiOperation[] };
}

export const test = browserTest.extend<{ api: ReturnType<typeof fixtureApi> }>({
  api: async ({ page }, use) => {
    const api = fixtureApi();
    await api.server.ready();
    await page.route(`${origins.api}/api/v1/**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const operation = (Object.keys(API_ROUTES) as ApiOperation[]).find((key) => API_ROUTES[key] === pathname);
      if (!operation) throw new Error(`No fixture for API route ${pathname}`);
      api.requests.push(operation);
      const response = await api.server.inject({
        method: 'POST', url: pathname,
        headers: { origin: origins.workspace, 'content-type': 'application/json' },
        payload: request.postData() ?? '',
      });
      apiResponseSchemas[operation].parse(response.json());
      const headers = Object.fromEntries(Object.entries(response.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
    });
    try { await use(api); } finally { await api.server.close(); }
  },
});
