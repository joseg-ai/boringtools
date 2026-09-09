import type { Page } from '@playwright/test';
import { expect, test, origins } from '../../../../tests/fixtures/integration/browser';
import { TOOL_IDS } from '@domos/catalog';

async function open(page: Page, id: string) {
  await page.goto(`/tools/${id}/`);
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear / reset' })).toBeVisible();
}
async function completed(page: Page) {
  await expect(page.getByText('Complete. Processed in this browser.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
}
test('production CSP hydrates all sixteen pages without outbound requests on load', async ({ page }) => {
  const errors: string[] = [];
  const remote: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (request) => { if (!request.url().startsWith(`${origins.workspace}/`)) remote.push(request.url()); });
  for (const id of TOOL_IDS) await open(page, id);
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});
test('JSON format, validation and clear', async ({ page }) => {
  await open(page, 'json-yaml-workbench');
  await page.getByLabel('JSON or YAML input').fill('{"port":443,"enabled":true}');
  await page.getByRole('button', { name: 'Transform document' }).click();
  await completed(page);
  await expect(page.locator('.result-text')).toContainText('"port": 443');
  await page.getByRole('button', { name: 'Clear / reset' }).click();
  await expect(page.getByLabel('JSON or YAML input')).toHaveValue('');
  await expect(page.locator('.result-text')).toHaveCount(0);
});
test('Base64 performs UTF-8 encoding', async ({ page }) => {
  await open(page, 'base64');
  await page.getByLabel('Text or hexadecimal bytes').fill('hello');
  await page.getByRole('button', { name: 'Encode bytes' }).click();
  await completed(page);
  await expect(page.locator('.result-text')).toHaveText('aGVsbG8=');
});
test('URL duplicate parameters remain distinct', async ({ page }) => {
  await open(page, 'url-workbench');
  await page.getByLabel('Absolute URL').fill('https://example.com/?tag=one&tag=two');
  await page.getByRole('button', { name: 'Process URL' }).click();
  await completed(page);
  await expect(page.getByRole('cell', { name: 'tag', exact: true })).toHaveCount(2);
});
test('JWT remains unverified after decoding', async ({ page }) => {
  await open(page, 'jwt-decoder');
  await page.getByLabel('JWT token').fill('eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.');
  await page.getByRole('button', { name: 'Decode unverified token' }).click();
  await completed(page);
  await expect(page.getByText('UNVERIFIED / signature not checked')).toBeVisible();
});
test('SHA worker produces a real digest under production CSP', async ({ page }) => {
  await open(page, 'sha-checksums');
  await page.getByLabel('Text to hash').fill('hello');
  await page.getByRole('button', { name: 'Calculate checksums' }).click();
  await completed(page);
  await expect(page.locator('.result-text')).toHaveText('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});
test('file hashing reads a local file in a worker', async ({ page }) => {
  await open(page, 'sha-checksums');
  await page.getByLabel('Hash source').selectOption('file');
  await page.getByLabel('Local file').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByRole('button', { name: 'Calculate checksums' }).click();
  await expect(page.getByText('File hashing complete.', { exact: true })).toBeVisible();
  await expect(page.locator('.result-text')).toHaveText('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});
test('regex worker renders captures', async ({ page }) => {
  await open(page, 'regex-tester');
  await page.getByLabel('Regex pattern').fill('(?<name>[a-z]+)-(\\d+)');
  await page.getByLabel('Test input').fill('edge-12 api-34');
  await page.getByRole('button', { name: 'Test expression' }).click();
  await completed(page);
  await expect(page.getByRole('cell', { name: 'edge-12', exact: true })).toBeVisible();
});
test('diff worker exposes readable changes', async ({ page }) => {
  await open(page, 'text-diff');
  await page.getByLabel('Before text').fill('old\n');
  await page.getByLabel('After text').fill('new\n');
  await page.getByRole('button', { name: 'Compare text' }).click();
  await completed(page);
  await expect(page.locator('.diff-removed')).toContainText('old');
  await expect(page.locator('.diff-added')).toContainText('new');
});
test('cron previews ten runs in an explicit timezone', async ({ page }) => {
  await open(page, 'cron-helper');
  await page.getByLabel('Cron expression').fill('0 9 * * MON-FRI');
  await page.getByLabel('Reference time').fill('2026-01-01T00:00:00Z');
  await page.getByRole('button', { name: 'Show next 10 runs' }).click();
  await completed(page);
  await expect(page.locator('tbody tr')).toHaveCount(10);
});
test('epoch uses the selected unit', async ({ page }) => {
  await open(page, 'epoch-time');
  await page.getByLabel('Epoch value').fill('1704067200');
  await page.getByRole('button', { name: 'Convert time' }).click();
  await completed(page);
  await expect(page.locator('.pairs')).toContainText('2024-01-01T00:00:00.000Z');
});
test('chmod octal and symbolic output agree', async ({ page }) => {
  await open(page, 'chmod');
  await page.getByLabel('Octal mode', { exact: true }).fill('0755');
  await page.getByRole('button', { name: 'Calculate permissions' }).click();
  await completed(page);
  await expect(page.locator('.pairs')).toContainText('rwxr-xr-x');
});
test('passwords generate only on explicit action', async ({ page }) => {
  await open(page, 'password-generator');
  await expect(page.locator('.secrets code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate secrets' }).click();
  await completed(page);
  await expect(page.locator('.secrets code')).toHaveCount(1);
  await expect(page.locator('.secrets code')).toHaveText(/.{20}/);
});
test('email headers show reported authentication', async ({ page }) => {
  await open(page, 'email-header-analyzer');
  await page.getByLabel('Email headers').fill('Subject: Fixture\r\nFrom: sender@example.com\r\nAuthentication-Results: mx.example.com; spf=pass\r\n');
  await page.getByRole('button', { name: 'Analyze headers' }).click();
  await completed(page);
  await expect(page.getByText('VERIFICATION NOT PERFORMED')).toBeVisible();
});
test('subnet /31 split, sibling join and /0 labels', async ({ page }) => {
  await open(page, 'ipv4-subnet-planner');
  await page.getByLabel('Base IPv4 CIDR').fill('192.0.2.0/31');
  await page.getByRole('button', { name: 'Create / replace plan' }).click();
  await completed(page);
  await page.getByRole('checkbox', { name: 'Select 192.0.2.0/31' }).check();
  await page.getByRole('button', { name: 'Split selected block' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select 192.0.2.0/32' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select 192.0.2.0/32' }).check();
  await page.getByRole('checkbox', { name: 'Select 192.0.2.1/32' }).check();
  await page.getByRole('button', { name: 'Join selected siblings' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select 192.0.2.0/31' })).toBeVisible();
  await page.getByLabel('Base IPv4 CIDR').fill('0.0.0.0/0');
  await page.getByRole('button', { name: 'Create / replace plan' }).click();
  await expect(page.getByText('/0: entire IPv4 space', { exact: true })).toBeVisible();
});
test('live partial reply is distinct from success and no target is opened', async ({ page }) => {
  let calls = 0;
  await page.route(`${origins.api}/api/v1/dns`, async (route) => {
    calls++;
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origins.workspace }, body: JSON.stringify({
      kind: 'partial', data: { name: 'example.com', resolver: 'fixture', queries: [{ type: 'A', status: 'negative', reason: 'NODATA', rcode: 0 }] },
      error: { code: 'TIMEOUT', phase: 'dns', message: 'Bounded fixture deadline' },
      meta: { requestId: 'fixture', observedAt: '2026-01-01T00:00:00Z', elapsedMs: 1, policyVersion: 'v1' },
    }) });
  });
  await open(page, 'dns-explorer');
  expect(calls).toBe(0);
  await page.getByLabel('DNS name or IP').fill('example.com');
  await page.getByRole('button', { name: 'Query DNS' }).click();
  await expect(page.getByRole('alert')).toContainText('PARTIAL RESULT');
  expect(calls).toBe(1);
  expect(page.url()).toBe(`${origins.workspace}/tools/dns-explorer/`);
});
test('small screens do not overflow and navigation remains usable', async ({ page }) => {
  for (const id of TOOL_IDS) {
    await open(page, id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (page.viewportSize()!.width <= 850) await expect(page.locator('.sidebar summary')).toBeVisible();
  }
  await page.goto(origins.site);
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Find a tool').fill('base64');
  await expect(page.locator('.tool-card')).toHaveCount(1);
});
test('regex deadline remains a visible failure', async ({ page }) => {
  await open(page, 'regex-tester');
  await page.getByLabel('Regex pattern').fill('(a+)+$');
  await page.getByLabel('Test input').fill('a'.repeat(5000) + '!');
  await page.getByRole('button', { name: 'Test expression' }).click();
  await expect(page.getByRole('alert')).toContainText('TIMEOUT');
  await expect(page.getByRole('button', { name: 'Test expression' })).toBeEnabled();
});
test('copy failure is visible and download is explicit', async ({ page }) => {
  await open(page, 'base64');
  await page.getByLabel('Text or hexadecimal bytes').fill('hello');
  await page.getByRole('button', { name: 'Encode bytes' }).click();
  await completed(page);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('permission denied')) } }); });
  await page.getByRole('button', { name: 'Copy result', exact: true }).click();
  await expect(page.getByText('Clipboard unavailable. Select and copy the visible result manually.')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('domos-result.txt');
});
test('page restore resets input without persisting secrets', async ({ page }) => {
  await open(page, 'jwt-decoder');
  await page.getByLabel('JWT token').fill('memory-only-value');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByLabel('JWT token')).toHaveValue('');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key !== 'domos-theme'))).toEqual([]);
  expect(page.url()).not.toContain('memory-only');
});
test('dark mode and tablet layout remain usable', async ({ page }) => {
  await open(page, 'password-generator');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Secret type').selectOption('passphrase');
  await page.getByRole('button', { name: 'Generate secrets' }).click();
  await completed(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('HTTP HEAD report preserves duplicate headers as inert text', async ({ page }) => {
  await page.route(`${origins.api}/api/v1/http`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ url: 'https://example.com', method: 'HEAD' });
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origins.workspace }, body: JSON.stringify({
      kind: 'result', data: {
        requestedUrl: 'https://example.com', method: 'HEAD', termination: 'complete',
        hops: [{ url: 'https://example.com', method: 'HEAD', remoteAddress: '93.184.215.14', statusCode: 200, durationMs: 5, location: null, headers: [
          { name: 'x-fixture', value: '<img src=x onerror=alert(1)>' }, { name: 'x-fixture', value: 'second value' },
        ] }],
      }, meta: { requestId: 'fixture', observedAt: '2026-01-01T00:00:00Z', elapsedMs: 5, policyVersion: 'v1' },
    }) });
  });
  await open(page, 'http-inspector');
  await expect(page.getByLabel('HTTP method')).toHaveValue('HEAD');
  await page.getByLabel('HTTP or HTTPS URL').fill('https://example.com');
  await page.getByRole('button', { name: 'Inspect with HEAD' }).click();
  await expect(page.getByRole('cell', { name: 'x-fixture', exact: true })).toHaveCount(2);
  await expect(page.getByRole('cell', { name: '<img src=x onerror=alert(1)>', exact: true })).toBeVisible();
  await expect(page.locator('main img')).toHaveCount(0);
});
test('email policy reports absent and unrequested policy without claiming verification', async ({ page }) => {
  await page.route(`${origins.api}/api/v1/email-policy`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ domain: 'example.com' });
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origins.workspace }, body: JSON.stringify({
      kind: 'result', data: {
        domain: 'example.com', organizationalDomain: 'example.com', resolver: 'fixture',
        spf: { status: 'absent', owner: 'example.com', records: [], findings: [], dependencies: [], lookupCount: 1, complete: true, unevaluated: [] },
        dmarc: { status: 'absent', owner: '_dmarc.example.com', records: [], findings: [], policy: null, organizationalFallback: false },
        dkim: { status: 'not-requested', owner: null, selector: null, records: [], findings: [] },
        evidence: [], queriesUsed: 2, queryBudget: 32, limitations: ['DNS observation is not sender verification.'], evaluationScope: 'dns-records-only', authentication: 'not-verified',
      }, meta: { requestId: 'fixture', observedAt: '2026-01-01T00:00:00Z', elapsedMs: 5, policyVersion: 'v1' },
    }) });
  });
  await open(page, 'email-dns-policy');
  await page.getByLabel('Email domain').fill('example.com');
  await page.getByRole('button', { name: 'Inspect email policy' }).click();
  await expect(page.getByText('AUTHENTICATION NOT VERIFIED', { exact: true })).toBeVisible();
  await expect(page.getByText('not-requested', { exact: true })).toBeVisible();
});
