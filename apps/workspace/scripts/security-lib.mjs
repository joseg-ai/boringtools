import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const commonHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
export function pagePolicy(html) {
  const hashes = new Set();
  for (const [, attributes, content] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = attributes?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (src && (!src.startsWith('/') || src.startsWith('//'))) throw new Error('External script found in static output.');
    if (!src && content) hashes.add(`'sha256-${createHash('sha256').update(content).digest('base64')}'`);
  }
  const live = /<meta\s+name="domos-processing-mode"\s+content="live"\s*\/?>/i.test(html);
  const configured = html.match(/<meta\s+name="domos-api-origin"\s+content="([^"]+)"\s*\/?>/i)?.[1];
  let connection = "'none'";
  if (live) {
    if (!configured) throw new Error('Live page is missing its compiled API origin.');
    const origin = new URL(configured);
    if (configured !== origin.origin || origin.protocol !== 'https:') throw new Error('Production live CSP requires an exact HTTPS API origin.');
    connection = origin.origin;
  }
  const policy = [
    "default-src 'none'", `script-src 'self' ${[...hashes].join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    `connect-src ${connection}`, "worker-src 'self'", "child-src 'none'", "frame-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  return { meta: policy, header: `${policy}; frame-ancestors 'none'` };
}
async function htmlFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await htmlFiles(path));
    else if (entry.name.endsWith('.html')) result.push(path);
  }
  return result;
}
export async function secureBuild(appRoot, workspace) {
  const dist = join(appRoot, 'dist');
  const sourceConfig = JSON.parse(await readFile(join(appRoot, 'public', 'staticwebapp.config.json'), 'utf8'));
  const pages = await htmlFiles(dist);
  if (!pages.length) throw new Error('Build HTML before generating security headers.');
  const routes = [];
  const documentHashes = new Set();
  for (const path of pages) {
    let html = await readFile(path, 'utf8');
    html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/gi, '');
    const policy = pagePolicy(html);
    for (const hash of policy.header.match(/'sha256-[^']+'/g) ?? []) documentHashes.add(hash);
    // Meta policies also protect astro preview; SWA response headers add framing protection.
    html = html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${policy.meta}">`);
    await writeFile(path, html);
    const fileRoute = `/${relative(dist, path).split(sep).join('/')}`;
    const route = fileRoute.endsWith('/index.html') ? fileRoute.slice(0, -10) : fileRoute;
    if (!policy.header.includes("connect-src 'none'")) routes.push({
      route: `${route}*`,
      headers: { 'Content-Security-Policy': policy.header, 'Cache-Control': 'no-store' },
    });
    if (route !== '/' && route.endsWith('/')) routes.push({ route: route.slice(0, -1), redirect: route, statusCode: 301 });
  }
  const config = {
    ...sourceConfig,
    routes: [...routes, ...(sourceConfig.routes ?? [])],
    globalHeaders: {
      ...sourceConfig.globalHeaders, ...commonHeaders,
      'Content-Security-Policy': pagePolicy('').header.replace("script-src 'self'", `script-src 'self' ${[...documentHashes].join(' ')}`),
    },
    responseOverrides: { '404': { rewrite: '/404.html', statusCode: 404 } },
  };
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 20 * 1024) throw new Error('Generated SWA configuration exceeds the 20 KiB frontend budget.');
  await writeFile(join(dist, 'staticwebapp.config.json'), serialized);
  process.stdout.write(`Secured ${pages.length} ${workspace ? 'workspace' : 'site'} documents; SWA config written to dist.\n`);
}
