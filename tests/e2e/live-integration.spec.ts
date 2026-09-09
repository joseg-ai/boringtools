import { test } from '../fixtures/integration/api';
import { expect, openTool, origins } from '../fixtures/integration/browser';
import { API_ROUTES, apiResponseSchemas } from '@domos/contracts';

test('DNS browser client consumes real API answer and NODATA envelopes', async ({ page, api }) => {
  await openTool(page, 'dns-explorer');
  expect(api.requests).toEqual([]);
  await page.getByLabel('DNS name or IP').fill('qa.example.com');
  await page.getByRole('button', { name: 'Query DNS' }).click();
  await expect(page.getByRole('cell', { name: '8.8.8.8', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '300', exact: true })).toBeVisible();
  await expect(page.getByText(/NODATA: name exists/)).toHaveCount(2);
  expect(api.requests).toEqual(['dns']);
  await page.getByRole('button', { name: 'Clear / reset' }).click();
  await expect(page.getByLabel('DNS name or IP')).toHaveValue('');
  await expect(page.getByText('No live request has been made.', { exact: false })).toBeVisible();
});

test('DNS NXDOMAIN is negative evidence, not a resolver error', async ({ page, api }) => {
  await openTool(page, 'dns-explorer');
  await page.getByLabel('DNS name or IP').fill('nx.example.com');
  await page.getByRole('button', { name: 'Query DNS' }).click();
  await expect(page.getByText(/NXDOMAIN: name does not exist/)).toHaveCount(3);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(api.requests).toEqual(['dns']);
});

test('DNS upstream failure remains a typed visible failure', async ({ page, api }) => {
  await openTool(page, 'dns-explorer');
  await page.getByLabel('DNS name or IP').fill('fail.example.com');
  await page.getByRole('button', { name: 'Query DNS' }).click();
  await expect(page.getByRole('alert').first()).toContainText('UPSTREAM_ERROR');
  await expect(page.getByText('REPORT RECEIVED / OBSERVATIONS, NOT A GUARANTEE')).toHaveCount(0);
  expect(api.requests).toEqual(['dns']);
});

test('email DNS partial SPF findings survive real API and client validation', async ({ page, api }) => {
  await openTool(page, 'email-dns-policy');
  expect(api.requests).toEqual([]);
  await page.getByLabel('Email domain').fill('mail.example.com');
  await page.getByRole('button', { name: 'Inspect email policy' }).click();
  await expect(page.getByRole('alert')).toContainText('PARTIAL RESULT');
  await expect(page.getByText('AUTHENTICATION NOT VERIFIED', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'broken.example.com', exact: true })).toBeVisible();
  await expect(page.getByText('not-requested', { exact: true })).toBeVisible();
  await expect(page.getByText(/Policy: reject;/)).toBeVisible();
  expect(api.requests).toEqual(['emailPolicy']);
});

test('HTTP real API redirect chain keeps HEAD and does not navigate the target', async ({ page, api }) => {
  await openTool(page, 'http-inspector');
  expect(api.requests).toEqual([]);
  await page.getByLabel('HTTP or HTTPS URL').fill('https://qa.example.com/redirect');
  await page.getByRole('button', { name: 'Inspect with HEAD' }).click();
  await expect(page.getByRole('cell', { name: 'HEAD 302', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'HEAD 200', exact: true })).toBeVisible();
  expect(api.calls.filter((call) => call.startsWith('http:'))).toEqual([
    'http:HEAD:/redirect:8.8.8.8', 'http:HEAD:/final:8.8.8.8',
  ]);
  expect(page.url()).toBe(`${origins.workspace}/tools/http-inspector/`);
});

test('HTTP blocked redirect preserves earlier evidence and transport failure is redacted', async ({ page, api }) => {
  await openTool(page, 'http-inspector');
  await page.getByLabel('HTTP or HTTPS URL').fill('https://qa.example.com/blocked');
  await page.getByRole('button', { name: 'Inspect with HEAD' }).click();
  await expect(page.getByRole('alert')).toContainText('PARTIAL RESULT');
  await expect(page.getByRole('alert')).toContainText('TARGET_BLOCKED');
  await expect(page.getByRole('cell', { name: 'HEAD 302', exact: true })).toBeVisible();
  expect(api.calls.filter((call) => call.startsWith('http:'))).toHaveLength(1);
  await page.getByLabel('HTTP or HTTPS URL').fill('https://qa.example.com/error');
  await page.getByRole('button', { name: 'Inspect with HEAD' }).click();
  await expect(page.getByRole('alert')).toContainText('INTERNAL_ERROR');
  await expect(page.locator('body')).not.toContainText('QA_SYNTHETIC_TRANSPORT_SENTINEL');
  await page.getByLabel('HTTP or HTTPS URL').fill('https://qa.example.com/upstream');
  await page.getByRole('button', { name: 'Inspect with HEAD' }).click();
  await expect(page.getByRole('alert')).toContainText('UPSTREAM_ERROR / tls');
});

test('API boundary rejects invalid payloads and wrong CORS preflights before adapters', async ({ api }) => {
  for (const operation of ['dns', 'emailPolicy', 'http'] as const) {
    const response = await api.server.inject({
      method: 'POST', url: API_ROUTES[operation],
      headers: { origin: origins.workspace }, payload: { unexpected: 'QA_SYNTHETIC_INPUT_SENTINEL' },
    });
    expect(response.statusCode).toBe(400);
    expect(apiResponseSchemas[operation].parse(response.json()).kind).toBe('error');
    expect(response.body).not.toContain('QA_SYNTHETIC_INPUT_SENTINEL');
    expect(response.headers['access-control-allow-origin']).toBe(origins.workspace);
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  for (const [origin, expected] of [[origins.workspace, 204], ['https://other.example.com', 422]] as const) {
    const response = await api.server.inject({
      method: 'OPTIONS', url: API_ROUTES.http,
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(response.statusCode).toBe(expected);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBe(expected === 204 ? origin : undefined);
  }
  expect(api.calls).toEqual([]);
});
