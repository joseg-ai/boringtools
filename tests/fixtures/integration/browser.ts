import { test as base, expect, type Page, type Download } from '@playwright/test';
import { PUBLIC_ORIGINS, type ToolId } from '@domos/catalog';
import { origins } from './origins';

export { expect, origins };
export const test = base.extend<{ releaseGuard: void }>({
  releaseGuard: [async ({ context, page }, use) => {
    const faults: string[] = [];
    page.on('pageerror', (error) => faults.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /content security policy|refused to (load|execute|connect)/i.test(message.text())) {
        faults.push(message.text());
      }
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if ([origins.site, origins.workspace].includes(url.origin) || ['blob:', 'data:'].includes(url.protocol)) {
        await route.continue();
        return;
      }
      // Exercise unchanged production links without ever contacting public hosts.
      // Canonical assertions still compare the original href before the click.
      const mapped = url.origin === PUBLIC_ORIGINS.site ? origins.site
        : url.origin === PUBLIC_ORIGINS.workspace ? origins.workspace : null;
      if (mapped && request.isNavigationRequest()) {
        await route.fulfill({ status: 307, headers: { location: `${mapped}${url.pathname}${url.search}${url.hash}` } });
        return;
      }
      faults.push(`Unfixtureed outbound ${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
    });
    await use();
    expect(faults, 'No unhandled page/CSP errors or unfixtureed outbound requests').toEqual([]);
  }, { auto: true }],
});

export async function openTool(page: Page, id: ToolId) {
  const response = await page.goto(`/tools/${id}/`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear / reset' })).toBeVisible();
}

export async function completed(page: Page) {
  await expect(page.getByText('Complete. Processed in this browser.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
}

export async function downloadText(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function syntheticJwt(payload: object) {
  return [JSON.stringify({ alg: 'none', typ: 'JWT' }), JSON.stringify(payload)]
    .map((value) => Buffer.from(value).toString('base64url')).join('.') + '.';
}
