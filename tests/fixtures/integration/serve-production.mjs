import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const servers = [];
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.xml': 'application/xml', '.woff2': 'font/woff2',
};

// Model SWA's first matching route and generated global/route headers. Never
// rewrite HTML or CSP: hydration and module workers must survive the real build.
export async function productionHandler(directory) {
  const config = JSON.parse(await readFile(resolve(directory, 'staticwebapp.config.json'), 'utf8'));
  await stat(resolve(directory, 'index.html'));
  return async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/__e2e/ready') {
        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('production fixtures ready');
        return;
      }
      const route = config.routes.find((entry) => entry.route.endsWith('*')
        ? pathname.startsWith(entry.route.slice(0, -1)) : pathname === entry.route);
      const headers = { ...config.globalHeaders, ...route?.headers };
      if (route?.redirect) {
        response.writeHead(route.statusCode ?? 302, { ...headers, Location: route.redirect }).end();
        return;
      }
      const decoded = decodeURIComponent(route?.rewrite ?? pathname);
      let file = resolve(directory, `.${decoded}`);
      if (!file.startsWith(`${directory}${sep}`) && file !== directory) {
        response.writeHead(403).end();
        return;
      }
      let statusCode = 200;
      const info = await stat(file).catch((error) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        return null;
      });
      if (info?.isDirectory()) file = resolve(file, 'index.html');
      if (!info) {
        statusCode = config.responseOverrides?.['404']?.statusCode ?? 404;
        file = resolve(directory, `.${config.responseOverrides?.['404']?.rewrite ?? '/404.html'}`);
      }
      const body = await readFile(file);
      response.writeHead(statusCode, { ...headers, 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      console.error('Production fixture failed:', error);
      response.writeHead(500).end('Production fixture failed.');
    }
  };
}

async function close() {
  await Promise.all(servers.map((server) => new Promise((done) => {
    server.close(done);
    server.closeAllConnections();
  })));
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
try {
  for (const [app, origin] of [
    ['site', process.env.E2E_SITE_ORIGIN ?? 'http://localhost:4321'],
    ['workspace', process.env.E2E_WORKSPACE_ORIGIN ?? 'http://localhost:4322'],
  ]) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Production fixtures bind only exact loopback HTTP origins.');
    }
    const server = createServer(await productionHandler(resolve(root, 'apps', app, 'dist')));
    servers.push(server);
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(Number(url.port), url.hostname, done);
    });
  }
} catch (error) {
  await close();
  throw error;
}
