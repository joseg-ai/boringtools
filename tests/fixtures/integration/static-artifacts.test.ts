import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pagePolicy, secureBuild } from '../../../apps/workspace/scripts/security-lib.mjs';

const apiOrigin = 'https://api.domosdigial.com';
const csp = 'Content-Security-Policy';
const validator = fileURLToPath(new URL('../../../infra/scripts/Test-StaticArtifacts.ps1', import.meta.url));
const livePaths = ['dns-explorer', 'email-dns-policy', 'http-inspector'].map((tool) => `/tools/${tool}/`);
interface Route {
  route: string;
  headers?: Record<string, string>;
  redirect?: string;
  statusCode?: number;
}
interface Config {
  globalHeaders: Record<string, string>;
  routes: Route[];
  responseOverrides: Record<string, { rewrite: string; statusCode: number }>;
}
interface Artifact {
  dist: string;
  config: Config;
  hashes: string[];
}

async function makeArtifact(root: string, app: 'site' | 'workspace'): Promise<Artifact> {
  const dist = join(root, 'apps', app, 'dist');
  const pages = app === 'site'
    ? ['index.html', '404.html', 'guides/index.html', 'guides/base64/index.html']
    : ['index.html', '404.html', 'tools/base64/index.html', ...livePaths.map((path) => `${path.slice(1)}index.html`)];
  const hashes = new Set<string>();
  const routes: Route[] = [];
  await mkdir(join(dist, '_astro'), { recursive: true });
  await writeFile(join(dist, '_astro', 'client.js'), 'export {};');
  for (const file of pages) {
    const route = `/${file}`.replace(/index\.html$/, '');
    const live = livePaths.includes(route);
    const metadata = app === 'site' ? '' : `<meta name="domos-processing-mode" content="${live ? 'live' : 'local'}">`
      + (live ? `<meta name="domos-api-origin" content="${apiOrigin}">` : '');
    const html = '<!doctype html><html><head>' + metadata + '</head><body>'
      + `<script type="module">document.documentElement.dataset.theme="${app}";</script>`
      + '<script>customElements.define("fixture-island", class extends HTMLElement {});</script>'
      + '<script type="module" src="/_astro/client.js"></script></body></html>';
    const policy = pagePolicy(html);
    for (const hash of policy.header.match(/'sha256-[^']+'/g) ?? []) hashes.add(hash);
    const output = join(dist, ...file.split('/'));
    await mkdir(join(output, '..'), { recursive: true });
    await writeFile(output, html.replace('<head>', `<head><meta http-equiv="${csp}" content="${policy.meta}">`));
    if (live) routes.push({ route: `${route}*`, headers: { [csp]: policy.header, 'Cache-Control': 'no-store' } });
    if (route !== '/' && route.endsWith('/')) routes.push({ route: route.slice(0, -1), redirect: route, statusCode: 301 });
  }
  routes.push({
    route: '/_astro/*',
    headers: { [csp]: "default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'self'; object-src 'none'; base-uri 'none'" },
  });
  return {
    dist, hashes: [...hashes],
    config: {
      globalHeaders: { [csp]: pagePolicy('').header.replace("script-src 'self'", `script-src 'self' ${[...hashes].join(' ')}`) },
      routes,
      responseOverrides: { '404': { rewrite: '/404.html', statusCode: 404 } },
    },
  };
}

describe('offline static artifact release gate', () => {
  let root: string;
  let site: Artifact;
  let workspace: Artifact;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'domos-static-artifacts-'));
    site = await makeArtifact(root, 'site');
    workspace = await makeArtifact(root, 'workspace');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function validate(error?: string, origin = apiOrigin) {
    for (const app of [site, workspace]) {
      await writeFile(join(app.dist, 'staticwebapp.config.json'), JSON.stringify(app.config));
    }
    const result = spawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', validator, '-ApiOrigin', origin, '-ArtifactRoot', root,
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(result.error, 'PowerShell 7 is required for the offline release gate tests').toBeUndefined();
    const output = result.stdout + result.stderr;
    if (error) {
      expect(result.status, output).not.toBe(0);
      expect(result.status).not.toBeNull();
      expect(output).toContain(error);
    } else {
      expect(result.status, output).toBe(0);
      expect(output).toContain('enforce effective SWA headers and hydration CSP');
    }
  }

  function liveRule() {
    const rule = workspace.config.routes.find((entry) => entry.route === `${livePaths[0]}*`);
    if (!rule?.headers) throw new Error('Fixture live CSP is required.');
    return rule.headers;
  }

  async function editHtml(app: Artifact, file: string, change: (html: string) => string) {
    const path = join(app.dist, ...file.split('/'));
    await writeFile(path, change(await readFile(path, 'utf8')));
  }

  it('accepts generated global/local policies, live wildcards, redirects, flat 404s and distinct layout hashes', async () => {
    expect(site.hashes[0]).not.toBe(workspace.hashes[0]);
    await validate();
  });

  it('uses the first matching live rule before a broader local fallback, not the last rule', async () => {
    workspace.config.routes.push({ route: '/tools/*', headers: { [csp]: workspace.config.globalHeaders[csp]! } });
    await validate();
  });

  it('merges header names case-insensitively and allows removal of an unrelated header', async () => {
    const headers = liveRule();
    headers['content-security-policy'] = headers[csp]!;
    delete headers[csp];
    headers['Cache-Control'] = '';
    await validate();
  });

  it('accepts exact canonical and index document policies as well as wildcards', async () => {
    const rules = workspace.config.routes.filter((rule) => rule.route.endsWith('/*') && rule.route !== '/_astro/*');
    for (const rule of rules) {
      if (!rule.headers) throw new Error('Fixture live CSP is required.');
      rule.route = rule.route.slice(0, -1);
      workspace.config.routes.unshift({ route: `${rule.route}index.html`, headers: rule.headers });
    }
    await validate();
  });

  it('allows static asset cache rules to inherit global security headers', async () => {
    for (const app of [site, workspace]) {
      const assets = app.config.routes.find((rule) => rule.route === '/_astro/*');
      if (!assets) throw new Error('Fixture asset rule is required.');
      assets.headers = { 'Cache-Control': 'public, max-age=31536000, immutable' };
    }
    await validate();
  });

  it('does not fall through a matching headerless rule to a later live CSP', async () => {
    workspace.config.routes.unshift({ route: `${livePaths[0]}index.html`, headers: { 'Cache-Control': 'no-store' } });
    await validate('CSP connect-src');
  });

  it('rejects the wrong release API origin even if each artifact is otherwise valid', async () => {
    await validate('compiled for a different API origin', 'https://wrong-api.invalid');
  });

  it.each([
    ['an unsafe global connection wildcard', "connect-src 'none'", 'connect-src *', 'CSP connect-src'],
    ['local self connections', "connect-src 'none'", "connect-src 'self'", 'CSP connect-src'],
    ['an external script origin', "script-src 'self'", "script-src 'self' https://ads.invalid", 'CSP script-src'],
    ['unsafe inline execution', "script-src 'self'", "script-src 'self' 'unsafe-inline'", 'CSP script-src'],
    ['eval execution', "script-src 'self'", "script-src 'self' 'unsafe-eval'", 'CSP script-src'],
    ['external fonts', "font-src 'self'", 'font-src https://fonts.invalid', 'CSP font-src'],
    ['frames', "frame-src 'none'", "frame-src 'self'", 'CSP frame-src'],
    ['external workers', "worker-src 'self'", 'worker-src https://worker.invalid', 'CSP worker-src'],
    ['external images', "img-src 'self' data:", "img-src 'self' data: https://beacon.invalid", 'CSP img-src'],
    ['form submissions', "form-action 'none'", "form-action 'self'", 'CSP form-action'],
    ['a duplicate directive', "connect-src 'none'", "connect-src 'none'; connect-src *", 'Duplicate or empty CSP'],
    ['duplicate connection sources', "connect-src 'none'", "connect-src 'none' 'none'", 'Duplicate CSP source'],
    ['an overriding script directive', "script-src 'self'", "script-src-elem *; script-src 'self'", 'Unsupported CSP directive'],
    ['a report endpoint', "connect-src 'none'", "report-uri https://reports.invalid; connect-src 'none'", 'Unsupported CSP directive'],
    ['a missing connect directive', "connect-src 'none';", '', 'explicitly define connect-src'],
  ])('rejects %s in global headers independently of restrictive meta policies', async (_label, before, after, error) => {
    workspace.config.globalHeaders[csp] = workspace.config.globalHeaders[csp]!.replace(before, after);
    await validate(error);
  });

  it.each(['*', "'self'", `${apiOrigin} https://other.invalid`, 'https://other.invalid', `${apiOrigin}/`])(
    'rejects live connections other than the single exact origin: %s', async (connection) => {
      const headers = liveRule();
      headers[csp] = headers[csp]!.replace(`connect-src ${apiOrigin}`, `connect-src ${connection}`);
      await validate('CSP connect-src');
    },
  );

  it('rejects broad live wildcard permissions that include local tools', async () => {
    workspace.config.routes.unshift({ route: '/tools/*', headers: { ...liveRule() } });
    await validate('CSP connect-src');
  });

  it('rejects unsafe exact index headers even when the canonical live route is correct', async () => {
    workspace.config.routes.unshift({
      route: `${livePaths[0]}index.html`,
      headers: { [csp]: liveRule()[csp]!.replace(`connect-src ${apiOrigin}`, 'connect-src *') },
    });
    await validate('CSP connect-src');
  });

  it('rejects CSP header removal instead of treating it as inheritance', async () => {
    workspace.config.routes.unshift({ route: '/404.html', headers: { [csp]: '' } });
    await validate('Missing Content-Security-Policy');
  });

  it('requires actual hydration hashes in response headers, not just valid-looking hashes', async () => {
    workspace.config.globalHeaders[csp] = workspace.config.globalHeaders[csp]!.replace(workspace.hashes[0]!, '');
    await validate('does not permit the actual inline hydration script');
  });

  it('does not allow the marketing layout hash in the workspace policy', async () => {
    workspace.config.globalHeaders[csp] = workspace.config.globalHeaders[csp]!.replace("script-src 'self'", `script-src 'self' ${site.hashes[0]}`);
    await validate('unknown inline script hash');
  });

  it('rejects hashes that do not belong to any built script', async () => {
    site.config.globalHeaders[csp] = site.config.globalHeaders[csp]!.replace("script-src 'self'", `script-src 'self' 'sha256-${'A'.repeat(43)}='`);
    await validate('unknown inline script hash');
  });

  it('requires self for compiled module scripts', async () => {
    workspace.config.globalHeaders[csp] = workspace.config.globalHeaders[csp]!.replace("script-src 'self'", 'script-src');
    await validate("script-src is missing required source 'self'");
  });

  it('requires actual hydration hashes in the meta policy too', async () => {
    await editHtml(workspace, 'index.html', (html) => html.replace(workspace.hashes[0]!, ''));
    await validate('does not permit the actual inline hydration script');
  });

  it.each(['https://ads.invalid/sdk.js', '//ads.invalid/sdk.js', '/missing.js'])('rejects external or absent scripts: %s', async (src) => {
    await editHtml(workspace, 'index.html', (html) => html.replace('/_astro/client.js', src));
    await validate('External or missing script');
  });

  it('rejects changed inline code with stale policies', async () => {
    await editHtml(workspace, 'index.html', (html) => html.replace('dataset.theme="workspace"', 'dataset.theme="changed"'));
    await validate('unknown inline script hash');
  });

  it('requires workspace processing metadata while allowing the marketing layout without it', async () => {
    await editHtml(workspace, '404.html', (html) => html.replace('<meta name="domos-processing-mode" content="local">', ''));
    await validate('Invalid processing mode');
  });

  it('rejects duplicate or invalid metadata', async () => {
    await editHtml(workspace, 'index.html', (html) => html.replace('</head>', '<meta name="domos-processing-mode" content="live"></head>'));
    await validate('ambiguous page metadata');
  });

  it('rejects live documents on the marketing site', async () => {
    await editHtml(site, 'index.html', (html) => html.replace('</head>', '<meta name="domos-processing-mode" content="live"></head>'));
    await validate('Invalid processing mode');
  });

  it.each(['/unknown/*', '/unknown.html', '/tools/dns-explorer*', '/tools/*/index.html'])('fails closed on unknown or unsupported routes: %s', async (route) => {
    workspace.config.routes.unshift({ route, headers: { [csp]: workspace.config.globalHeaders[csp]! } });
    await validate(route.startsWith('/unknown') ? 'Unknown SWA document route' : 'unsupported SWA route pattern');
  });

  it('rejects duplicate routes rather than making policy order ambiguous', async () => {
    workspace.config.routes.push({ route: `${livePaths[0]}*`, headers: { ...liveRule() } });
    await validate('duplicate or unsupported SWA route pattern');
  });

  it('rejects flat and directory documents sharing a canonical URL', async () => {
    const html = await readFile(join(workspace.dist, 'tools', 'base64', 'index.html'), 'utf8');
    await writeFile(join(workspace.dist, 'tools', 'base64.html'), html);
    await validate('Ambiguous static document path');
  });

  it('rejects header casing collisions', async () => {
    workspace.config.globalHeaders['content-security-policy'] = workspace.config.globalHeaders[csp]!;
    await validate('ambiguous header definition');
  });

  it('rejects unsupported rewrites instead of validating the wrong document', async () => {
    const config = { ...workspace.config, navigationFallback: { rewrite: '/index.html' } };
    Object.assign(workspace.config, config);
    await validate('Unsupported SWA configuration');
  });

  it('requires the real static 404 response override', async () => {
    workspace.config.responseOverrides['404']!.rewrite = '/index.html';
    await validate('Expected the static /404.html response override');
  });

  it('rejects redirects to external or different documents', async () => {
    workspace.config.routes.unshift({ route: '/', redirect: 'https://other.invalid', statusCode: 301 });
    await validate('Unsupported or ambiguous static redirect');
  });

  it.each([307, 308])('rejects redirect status %s unsupported by Azure Static Web Apps', async (statusCode) => {
    const redirect = workspace.config.routes.find((rule) => rule.redirect);
    if (!redirect) throw new Error('Fixture redirect is required.');
    redirect.statusCode = statusCode;
    await validate('Unsupported or ambiguous static redirect');
  });

  it('generates canonical redirects accepted by Azure Static Web Apps', async () => {
    const appRoot = join(workspace.dist, '..');
    await mkdir(join(appRoot, 'public'));
    await writeFile(join(appRoot, 'public', 'staticwebapp.config.json'), '{}');
    await secureBuild(appRoot, true);
    workspace.config = JSON.parse(await readFile(join(workspace.dist, 'staticwebapp.config.json'), 'utf8'));
    const redirects = workspace.config.routes.filter((rule) => rule.redirect);
    expect(redirects.length).toBeGreaterThan(0);
    expect(redirects.every((rule) => rule.statusCode === 301)).toBe(true);
    await validate();
  });

  it('rejects unsafe asset-route policies', async () => {
    const assets = workspace.config.routes.find((rule) => rule.route === '/_astro/*');
    if (!assets?.headers) throw new Error('Fixture asset headers are required.');
    assets.headers[csp] = assets.headers[csp]!.replace("connect-src 'none'", 'connect-src *');
    await validate('CSP connect-src');
  });

  it('requires exactly three live documents', async () => {
    const removed = livePaths[0]!;
    await rm(join(workspace.dist, ...removed.slice(1).split('/'), 'index.html'));
    workspace.config.routes = workspace.config.routes.filter((rule) => !rule.route.startsWith(removed.slice(0, -1)));
    await validate('Expected exactly three real live-tool workspace pages');
  });
});
