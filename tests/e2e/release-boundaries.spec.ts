import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_CATALOG, LOCAL_TOOL_IDS, LIVE_TOOL_IDS, PUBLIC_ORIGINS, type LocalToolId } from '@domos/catalog';
import { test, expect, origins, openTool, completed, syntheticJwt } from '../fixtures/integration/browser';
import type { Page } from '@playwright/test';

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Only result tables, not the document, may scroll horizontally').toBe(true);
}

async function capture(page: Page, filename: string) {
  if (!process.env.E2E_CAPTURE_DIR) return;
  await mkdir(process.env.E2E_CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.E2E_CAPTURE_DIR, filename), fullPage: true });
}

test('all 16 guides and tools have complete built routes, matching policies and no dead first-party links', async ({ page, request }) => {
  expect(TOOL_CATALOG).toHaveLength(16);
  expect(LOCAL_TOOL_IDS).toHaveLength(13);
  expect(LIVE_TOOL_IDS).toHaveLength(3);
  const checked = new Set<string>();
  for (const tool of TOOL_CATALOG) {
    const response = await page.goto(`${origins.site}${tool.guidePath}`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain("connect-src 'none'");
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tool.guideTitle);
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', `${PUBLIC_ORIGINS.site}${tool.guidePath}`);
    expect((await page.locator('article').innerText()).length).toBeGreaterThan(900);
    await noPageOverflow(page);
    await openTool(page, tool.id);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tool.title);
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, follow');
    await expect(page.locator('main')).not.toContainText(/foundation pending|coming soon|not implemented/i);
    const doc = await request.get(`${origins.workspace}${tool.toolPath}`);
    const csp = doc.headers()['content-security-policy']!;
    expect(csp).toContain(tool.mode === 'local' ? "connect-src 'none'" : `connect-src ${origins.api}`);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp.split(';').find((part) => part.trim().startsWith('script-src'))).not.toContain("'unsafe-inline'");
    expect(csp).toContain("worker-src 'self'");
    const resources = await page.locator('script[src],link[rel=stylesheet],link[rel=preload],link[rel=preconnect],link[rel=dns-prefetch]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('src') ?? element.getAttribute('href') ?? ''));
    expect(resources.every((value) => value.startsWith('/') && !value.startsWith('//'))).toBe(true);
    await expect(page.locator('iframe')).toHaveCount(0);
    await noPageOverflow(page);
    const links = await page.locator('a[href]').evaluateAll((elements) =>
      elements.map((element) => (element as HTMLAnchorElement).href));
    for (const value of links) {
      const url = new URL(value);
      const origin = url.origin === PUBLIC_ORIGINS.site ? origins.site
        : url.origin === PUBLIC_ORIGINS.workspace ? origins.workspace : url.origin;
      expect([origins.site, origins.workspace]).toContain(origin);
      const target = `${origin}${url.pathname}`;
      if (checked.has(target)) continue;
      checked.add(target);
      expect((await request.get(target)).status(), `Broken link ${target}`).toBe(200);
    }
  }
  for (const origin of [origins.site, origins.workspace]) {
    expect((await request.get(`${origin}/not-a-release-route/`)).status()).toBe(404);
  }
});

test('public navigation crosses to a separate hydrated workspace and returns to the guide', async ({ page }, info) => {
  await page.goto(origins.site);
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await noPageOverflow(page);
  if (info.project.name === 'desktop-1440') await capture(page, 'lambert-homepage-desktop.png');
  const link = page.getByRole('link', { name: 'Open subnet planner', exact: false });
  await expect(link).toHaveAttribute('href', `${PUBLIC_ORIGINS.workspace}/tools/ipv4-subnet-planner/`);
  await link.click();
  await expect(page).toHaveURL(`${origins.workspace}/tools/ipv4-subnet-planner/`);
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Load sample CIDR' }).click();
  await page.getByRole('button', { name: 'Create / replace plan' }).click();
  await completed(page);
  await page.getByRole('checkbox', { name: 'Select 10.42.0.0/16', exact: true }).check();
  await page.getByRole('button', { name: 'Split selected block' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select 10.42.0.0/17', exact: true })).toBeVisible();
  await noPageOverflow(page);
  if (info.project.name === 'desktop-1440') await capture(page, 'lambert-subnet-desktop.png');
  if (info.project.name === 'phone-320') await capture(page, 'lambert-subnet-mobile-320.png');
  await page.getByRole('link', { name: 'Read the practical guide' }).click();
  await expect(page).toHaveURL(`${origins.site}/guides/ipv4-subnet-planner/`);
  await expect(page.getByRole('heading', { name: 'Plan IPv4 allocations with split and join', exact: true })).toBeVisible();
});

test('primary controls have touch targets and visible keyboard focus, with table equivalence', async ({ page }) => {
  await openTool(page, 'ipv4-subnet-planner');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to tool', exact: true })).toBeFocused();
  const skip = page.getByRole('link', { name: 'Skip to tool', exact: true });
  expect(await skip.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.getByLabel('Base IPv4 CIDR').fill('192.0.2.0/24');
  await page.getByRole('button', { name: 'Create / replace plan' }).click();
  await completed(page);
  const checkbox = page.getByRole('checkbox', { name: 'Select 192.0.2.0/24', exact: true });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole('region', { name: 'Keyboard allocation table / page 1', exact: true })).toHaveAttribute('tabindex', '0');
  for (const control of await page.locator('main button:visible, main input:not([type=checkbox]):visible, main select:visible, main .check:visible').all()) {
    const box = await control.boundingBox();
    expect(box?.height, (await control.textContent())?.slice(0, 80)).toBeGreaterThanOrEqual(44);
    if (await control.evaluate((element) => element.classList.contains('check'))) {
      expect(Math.round(box?.width ?? 0), 'Checkbox label must be a usable touch target (CSS pixels)').toBeGreaterThanOrEqual(44);
    }
  }
  await noPageOverflow(page);
});

test('development servers render localhost links rather than production navigation', async ({ request }, info) => {
  test.setTimeout(90_000);
  const { dev } = await import('astro');
  for (const app of ['site', 'workspace'] as const) {
    const server = await dev({
      root: fileURLToPath(new URL(`../../apps/${app}/`, import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
      devToolbar: { enabled: false },
      vite: { cacheDir: info.outputPath(`dev-cache-${app}`) },
    });
    try {
      const response = await request.get(`http://127.0.0.1:${server.address.port}${app === 'site' ? '/' : '/tools/base64/'}`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain(app === 'site'
        ? 'href="http://localhost:4322/tools/ipv4-subnet-planner/"'
        : 'href="http://localhost:4321/guides/base64/"');
      expect(html).not.toContain(app === 'site'
        ? `href="${PUBLIC_ORIGINS.workspace}/tools/`
        : `href="${PUBLIC_ORIGINS.site}/guides/`);
    } finally {
      await server.stop();
    }
  }
});

const sentinel = 'QA_MEMORY_ONLY_74e19';
const privacyInputs: Record<LocalToolId, (page: Page) => Promise<void>> = {
  'ipv4-subnet-planner': async (page) => {
    await page.getByLabel('Base IPv4 CIDR').fill('192.0.2.0/24');
    await page.getByRole('button', { name: 'Create / replace plan' }).click();
    await completed(page);
    await page.getByRole('checkbox', { name: 'Select 192.0.2.0/24', exact: true }).check();
    await page.getByLabel('Allocation note').fill(sentinel);
    await page.getByRole('button', { name: 'Save note and color' }).click();
  },
  'json-yaml-workbench': async (page) => {
    await page.getByLabel('JSON or YAML input').fill(JSON.stringify({ value: sentinel }));
    await page.getByRole('button', { name: 'Transform document' }).click();
  },
  base64: async (page) => {
    await page.getByLabel('Text or hexadecimal bytes').fill(sentinel);
    await page.getByRole('button', { name: 'Encode bytes' }).click();
  },
  'url-workbench': async (page) => {
    await page.getByLabel('Absolute URL').fill(`https://qa.invalid/${sentinel}?value=${sentinel}`);
    await page.getByRole('button', { name: 'Process URL' }).click();
  },
  'jwt-decoder': async (page) => {
    await page.getByLabel('JWT token').fill(syntheticJwt({ sub: sentinel }));
    await page.getByRole('button', { name: 'Decode unverified token' }).click();
  },
  'sha-checksums': async (page) => {
    await page.getByLabel('Text to hash').fill(sentinel);
    await page.getByRole('button', { name: 'Calculate checksums' }).click();
  },
  'regex-tester': async (page) => {
    await page.getByLabel('Regex pattern').fill(sentinel);
    await page.getByLabel('Test input').fill(sentinel);
    await page.getByRole('button', { name: 'Test expression' }).click();
  },
  'text-diff': async (page) => {
    await page.getByLabel('Before text').fill(sentinel);
    await page.getByLabel('After text').fill(`${sentinel}\nafter`);
    await page.getByRole('button', { name: 'Compare text' }).click();
  },
  'cron-helper': async (page) => {
    await page.getByLabel('Cron expression').fill(sentinel);
    await page.getByRole('button', { name: 'Show next 10 runs' }).click();
  },
  'epoch-time': async (page) => {
    await page.getByLabel('Epoch value').fill(sentinel);
    await page.getByRole('button', { name: 'Convert time' }).click();
  },
  chmod: async (page) => {
    await page.getByLabel('Octal mode', { exact: true }).fill('qa74');
    await page.getByRole('button', { name: 'Calculate permissions' }).click();
  },
  'password-generator': async (page) => {
    await page.getByLabel('Secret type').selectOption('passphrase');
    await page.getByLabel('Word separator').fill('qa74');
    await page.getByRole('button', { name: 'Generate secrets' }).click();
  },
  'email-header-analyzer': async (page) => {
    await page.getByLabel('Email headers').fill(`Subject: ${sentinel}\r\nAuthentication-Results: qa.invalid; spf=pass\r\n`);
    await page.getByRole('button', { name: 'Analyze headers' }).click();
  },
};

for (const id of LOCAL_TOOL_IDS) test(`${id} keeps synthetic inputs out of network, URL and persistence`, async ({ page, context }) => {
  await openTool(page, id);
  const requests: { type: string; url: string; body: string | null }[] = [];
  page.on('request', (request) => requests.push({ type: request.resourceType(), url: request.url(), body: request.postData() }));
  await privacyInputs[id](page);
  if (['cron-helper', 'epoch-time', 'chmod'].includes(id)) await expect(page.getByRole('alert')).toBeVisible();
  else await completed(page);
  expect(requests.filter((request) => !['script', 'stylesheet', 'font', 'image', 'other'].includes(request.type))).toEqual([]);
  expect(requests.every((request) => request.url.startsWith(`${origins.workspace}/`) && !request.body)).toBe(true);
  expect(JSON.stringify(requests)).not.toContain(sentinel);
  expect(page.url()).toBe(`${origins.workspace}/tools/${id}/`);
  const stored = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'domos-theme')),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    history: history.state,
  }));
  expect(stored.local).toEqual({});
  expect(stored.session).toEqual({});
  expect(JSON.stringify(stored)).not.toMatch(/QA_MEMORY_ONLY_74e19|qa74/);
  expect(await context.cookies()).toEqual([]);
  await page.reload();
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  expect((await page.locator('input:not([type=checkbox]),textarea').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLInputElement).value))).join(' ')).not.toMatch(/QA_MEMORY_ONLY_74e19|qa74/);
});
