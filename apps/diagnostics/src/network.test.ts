import http from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { createConnection, createServer, Socket, type Server } from 'node:net';
import type { DetailedPeerCertificate } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@domos/contracts';
import { ConnectionLimiter } from './limits.js';
import { createPinnedTransport, createWireExchange, type NativeRequests } from './network.js';
import { httpTarget } from './public-policy.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function localServer(onData: (socket: Socket, data: Buffer) => void) {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => { /* A deliberate client abort is expected in these fixtures. */ });
    socket.on('data', (data) => onData(socket, data));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture bind failed.');
  return address.port;
}

function localRequests(port: number, peer: string, captured: RequestOptions[]): NativeRequests {
  return {
    http: (options) => {
      captured.push(options);
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => {
        const socket = createConnection({ host: '127.0.0.1', port });
        // Only the internal native capability seam routes to this offline fixture.
        // Production options (asserted below) still name the vetted public IP.
        Object.defineProperty(socket, 'remoteAddress', { get: () => peer });
        sockets.add(socket);
        return socket;
      };
      return http.request({ ...options, agent });
    },
    https: (options) => {
      captured.push(options);
      return https.request({ ...options, hostname: '127.0.0.1', port });
    },
  };
}

class Certificate implements DetailedPeerCertificate {
  issuerCertificate = this;
  ca = false;
  raw = Buffer.alloc(0);
  subject = {};
  issuer = {};
  valid_from = '';
  valid_to = '';
  serialNumber = '';
  fingerprint = '';
  fingerprint256 = '';
  fingerprint512 = '';
  constructor(readonly subjectaltname: string) {}
}

describe('production pinned Node transport (offline native socket fixtures)', () => {
  it('pins through the default production requester even with a proxy-configured global agent', async () => {
    let received = '';
    const port = await localServer((socket, bytes) => {
      received += bytes.toString();
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    });
    const originalConnect = Socket.prototype.connect;
    const originalAgent = http.globalAgent;
    const destinations: unknown[] = [];
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket, ...args) {
      // Intercept only the OS socket capability. The production request function,
      // agent selection, parser and peer validation all execute unchanged.
      const first = args[0];
      const options = Array.isArray(first) ? first[0] : first;
      destinations.push(options);
      Object.defineProperty(this, 'remoteAddress', { get: () => '8.8.8.8' });
      sockets.add(this);
      return Reflect.apply(originalConnect, this, [{ host: '127.0.0.1', port }]);
    });
    http.globalAgent = new http.Agent({ proxyEnv: { HTTP_PROXY: 'http://127.0.0.1:9' } });
    try {
      const transport = createPinnedTransport(new ConnectionLimiter());
      const result = await transport(httpTarget('http://example.com/pinned', []),
        '8.8.8.8', 'HEAD', new AbortController().signal);
      expect(result.remoteAddress).toBe('8.8.8.8');
      expect(destinations).toHaveLength(1);
      expect(destinations[0]).toMatchObject({ host: '8.8.8.8', port: 80, family: 4 });
      expect(received).toContain('HEAD /pinned HTTP/1.1');
      expect(received).not.toContain('HEAD http://');
    } finally {
      connect.mockRestore();
      http.globalAgent.destroy();
      http.globalAgent = originalAgent;
    }
  });

  it('actually passes the vetted numeric IP to Node, preserves Host, forbids lookup/proxy/reuse and never buffers a body', async () => {
    const captured: RequestOptions[] = [];
    let received = '';
    let closed = false;
    const port = await localServer((socket, bytes) => {
      received += bytes.toString();
      socket.once('close', () => { closed = true; });
      socket.write('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Encoding: gzip\r\nContent-Length: 99999999\r\n\r\nnot-gzip');
    });
    const transport = createPinnedTransport(new ConnectionLimiter(), localRequests(port, '8.8.8.8', captured));
    const target = httpTarget('http://example.com/path?query=1#fragment', []);
    const result = await transport(target, '8.8.8.8', 'GET', new AbortController().signal);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      hostname: '8.8.8.8', family: 4, port: 80, agent: false,
      method: 'GET', path: '/path?query=1', maxHeaderSize: LIMITS.httpHeaderBytes,
      headers: { Host: 'example.com', Connection: 'close', 'Accept-Encoding': 'identity' },
    });
    expect(received).toContain('GET /path?query=1 HTTP/1.1');
    expect(received).toContain('Host: example.com');
    expect(received).not.toMatch(/Cookie:|Authorization:|Referer:/i);
    expect(result).not.toHaveProperty('body');
    expect(result.remoteAddress).toBe('8.8.8.8');
    expect(result.headers.filter((header) => header.name === 'Set-Cookie')).toHaveLength(2);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('rejects any peer other than the pinned address before accepting response headers', async () => {
    for (const peer of ['127.0.0.1', '168.63.129.16', '1.1.1.1', '::ffff:8.8.8.8']) {
      const port = await localServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
      const transport = createPinnedTransport(new ConnectionLimiter(), localRequests(port, peer, []));
      await expect(transport(httpTarget('http://example.com', []), '8.8.8.8', 'HEAD', new AbortController().signal))
        .rejects.toMatchObject({ detail: { code: 'TARGET_BLOCKED', phase: 'connect' } });
    }
  });

  it('rejects excessive header counts and oversized headers using the actual Node parser', async () => {
    for (const headers of [
      Array.from({ length: 101 }, (_value, index) => `X-${index}: a\r\n`).join(''),
      `X-Large: ${'a'.repeat(LIMITS.httpHeaderBytes)}\r\n`,
    ]) {
      const port = await localServer((socket) => socket.end(`HTTP/1.1 200 OK\r\n${headers}\r\n`));
      const transport = createPinnedTransport(new ConnectionLimiter(), localRequests(port, '8.8.8.8', []));
      await expect(transport(httpTarget('http://example.com', []), '8.8.8.8', 'HEAD', new AbortController().signal))
        .rejects.toMatchObject({ detail: { code: 'LIMIT_EXCEEDED', phase: 'headers' } });
    }
  });

  it('aborts a real stalled socket and retains hard capacity until sockets close', async () => {
    let connected = 0;
    const port = await localServer(() => { connected++; });
    const limiter = new ConnectionLimiter(1);
    const transport = createPinnedTransport(limiter, localRequests(port, '8.8.8.8', []));
    const controller = new AbortController();
    const pending = transport(httpTarget('http://example.com', []), '8.8.8.8', 'HEAD', controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ detail: { code: 'TIMEOUT' } });
    await vi.waitFor(() => expect(connected).toBe(1));
    await expect(transport(httpTarget('http://example.net', []), '8.8.8.8', 'HEAD', new AbortController().signal))
      .rejects.toMatchObject({ detail: { code: 'RATE_LIMITED' } });
    controller.abort();
    await rejected;
    await vi.waitFor(() => {
      const release = limiter.acquire(new AbortController().signal);
      release();
    });
  });

  it('uses native TLS identity verification for DNS and literal-IP SANs with certificate checks enabled', async () => {
    const captured: RequestOptions[] = [];
    const port = await localServer((socket) => socket.end('not a TLS server'));
    const transport = createPinnedTransport(new ConnectionLimiter(), localRequests(port, '8.8.8.8', captured));
    for (const target of ['https://example.com', 'https://8.8.8.8']) {
      await expect(transport(httpTarget(target, []), '8.8.8.8', 'HEAD', new AbortController().signal))
        .rejects.toMatchObject({ detail: { code: 'UPSTREAM_ERROR', phase: 'tls' } });
    }
    expect(captured[0]).toMatchObject({ hostname: '8.8.8.8', servername: 'example.com', rejectUnauthorized: true, agent: false });
    expect(captured[1]!.servername).toBeUndefined();
    expect(captured[0]!.checkServerIdentity!('8.8.8.8', new Certificate('DNS:example.com'))).toBeUndefined();
    expect(captured[0]!.checkServerIdentity!('example.com', new Certificate('DNS:other.example.net'))).toBeInstanceOf(Error);
    expect(captured[1]!.checkServerIdentity!('ignored', new Certificate('IP Address:8.8.8.8'))).toBeUndefined();
    expect(captured[1]!.checkServerIdentity!('ignored', new Certificate('DNS:8.8.8.8'))).toBeInstanceOf(Error);
  });

  it('pins the fixed DoH endpoint and discloses neither submitted names in paths nor custom resolvers', async () => {
    const captured: RequestOptions[] = [];
    const port = await localServer((socket) => socket.end('not a TLS server'));
    const exchange = createWireExchange(new ConnectionLimiter(), localRequests(port, '1.1.1.1', captured));
    await expect(exchange(Buffer.from('wire-dns-query'), new AbortController().signal)).rejects.toThrow();
    expect(captured[0]).toMatchObject({
      hostname: '1.1.1.1', servername: 'cloudflare-dns.com', path: '/dns-query', method: 'POST',
      headers: { Host: 'cloudflare-dns.com', Accept: 'application/dns-message', 'Content-Type': 'application/dns-message' },
      rejectUnauthorized: true, agent: false,
    });
  });
});
