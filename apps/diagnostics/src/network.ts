import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, TLSSocket } from 'node:tls';
import { LIMITS, type HttpHop } from '@domos/contracts';
import { SERVICE_LIMITS } from './config.js';
import { DiagnosticError, checkAbort } from './errors.js';
import { ConnectionLimiter } from './limits.js';
import { publicAddress, sameAddress, type Target } from './public-policy.js';

// Internal capability injection only; never populated from request data or env.
export interface NativeRequests {
  http: (options: RequestOptions) => ClientRequest;
  https: (options: RequestOptions) => ClientRequest;
}
const nativeRequests: NativeRequests = {
  http: (options) => http.request(options),
  https: (options) => https.request(options),
};

interface ExchangeOptions {
  hostname: string;
  address: string;
  secure: boolean;
  path: string;
  method: 'HEAD' | 'GET' | 'POST';
  signal: AbortSignal;
  body?: Buffer;
}
interface ExchangeResult {
  statusCode: number;
  headers: HttpHop['headers'];
  remoteAddress: string;
  body: Buffer;
}

function networkError(error: unknown, tls: boolean): DiagnosticError {
  if (error instanceof DiagnosticError) return error;
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'HPE_HEADER_OVERFLOW') return new DiagnosticError('LIMIT_EXCEEDED', 'headers');
  const cert = /TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code);
  return new DiagnosticError('UPSTREAM_ERROR', tls || cert ? 'tls' : 'connect');
}

function parseHeaders(raw: string[]): HttpHop['headers'] {
  if (raw.length % 2 || raw.length / 2 > LIMITS.httpHeaders) {
    throw new DiagnosticError('LIMIT_EXCEEDED', 'headers');
  }
  const headers: HttpHop['headers'] = [];
  let bytes = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!;
    const value = raw[index + 1]!;
    bytes += Buffer.byteLength(`${name}: ${value}\r\n`);
    if (name.length > 256 || bytes > LIMITS.httpHeaderBytes) {
      throw new DiagnosticError('LIMIT_EXCEEDED', 'headers');
    }
    headers.push({ name, value });
  }
  return headers;
}

function exchange(options: ExchangeOptions, limiter: ConnectionLimiter, requests: NativeRequests): Promise<ExchangeResult> {
  const address = publicAddress(options.address);
  const release = limiter.acquire(options.signal);
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    let hasSocket = false;
    let verifiedAddress: string | undefined;
    let phase: 'connect' | 'tls' | 'headers' = 'connect';
    const abort = () => fail(new DiagnosticError('TIMEOUT', phase));
    const cleanup = () => options.signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      reject(networkError(error, phase === 'tls'));
    };
    const succeed = (result: ExchangeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      resolve(result);
    };
    try {
      checkAbort(options.signal, 'connect');
      const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
        protocol: options.secure ? 'https:' : 'http:',
        // The connection host is the vetted numeric address, never the submitted
        // hostname. A fresh non-pooling agent cannot reuse or re-resolve a target.
        hostname: address,
        family: isIP(address),
        port: options.secure ? 443 : 80,
        method: options.method,
        path: options.path,
        agent: false,
        autoSelectFamily: false,
        maxHeaderSize: LIMITS.httpHeaderBytes,
        insecureHTTPParser: false,
        rejectUnauthorized: true,
        ...(options.secure && !isIP(options.hostname) ? { servername: options.hostname } : {}),
        checkServerIdentity: (_host, certificate) => checkServerIdentity(options.hostname, certificate),
        lookup: (_hostname, _lookupOptions, callback) => {
          callback(new DiagnosticError('TARGET_BLOCKED', 'connect'), '', 0);
        },
        headers: {
          Host: isIP(options.hostname) === 6 ? `[${options.hostname}]` : options.hostname,
          'User-Agent': 'Domos-Public-Diagnostics/1',
          Accept: options.body ? 'application/dns-message' : '*/*',
          'Accept-Encoding': 'identity',
          Connection: 'close',
          ...(options.body ? {
            'Content-Type': 'application/dns-message',
            'Content-Length': String(options.body.length),
          } : {}),
        },
      };
      request = (options.secure ? requests.https : requests.http)(requestOptions);
      // 0 disables silent Node header-count truncation. Bytes remain parser-bounded;
      // parseHeaders rejects >100 instead of returning a truncated observation.
      request.maxHeadersCount = 0;
      request.once('socket', (socket) => {
        hasSocket = true;
        socket.once('close', release);
        const verify = () => {
          try {
            checkAbort(options.signal, phase);
            if (!socket.remoteAddress || !sameAddress(socket.remoteAddress, address)) {
              throw new DiagnosticError('TARGET_BLOCKED', 'connect');
            }
            if (options.secure) {
              if (!(socket instanceof TLSSocket) || !socket.authorized) {
                throw new DiagnosticError('UPSTREAM_ERROR', 'tls');
              }
              // TLS can omit hostname verification for IP literals when no SNI is
              // set. Explicitly verify SAN IPs as well as DNS names after handshake.
              if (checkServerIdentity(options.hostname, socket.getPeerCertificate())) {
                throw new DiagnosticError('UPSTREAM_ERROR', 'tls');
              }
            }
            verifiedAddress = publicAddress(socket.remoteAddress);
            phase = 'headers';
          } catch (error) { fail(error); }
        };
        if (options.secure) {
          phase = 'tls';
          socket.once('secureConnect', verify);
        } else if (socket.connecting) socket.once('connect', verify);
        else verify();
      });
      request.once('close', () => { if (!hasSocket) release(); });
      request.once('error', (error) => fail(error));
      let informationCount = 0;
      let informationBytes = 0;
      request.on('information', (info) => {
        try {
          informationCount++;
          const headers = parseHeaders(info.rawHeaders);
          informationBytes += headers.reduce((total, header) =>
            total + Buffer.byteLength(`${header.name}: ${header.value}\r\n`), 0);
          if (informationCount > 5 || informationBytes > LIMITS.httpHeaderBytes) {
            throw new DiagnosticError('LIMIT_EXCEEDED', 'headers');
          }
        } catch (error) { fail(error); }
      });
      request.once('upgrade', (_res, socket) => {
        socket.destroy();
        fail(new DiagnosticError('UPSTREAM_ERROR', 'headers'));
      });
      request.once('response', (res) => {
        response = res;
        res.once('error', (error) => fail(error));
        try {
          checkAbort(options.signal, 'headers');
          if (!verifiedAddress || !res.socket.remoteAddress
            || !sameAddress(res.socket.remoteAddress, verifiedAddress)) {
            throw new DiagnosticError('TARGET_BLOCKED', 'connect');
          }
          const headers = parseHeaders(res.rawHeaders);
          const result: ExchangeResult = {
            statusCode: res.statusCode ?? 0, headers, remoteAddress: verifiedAddress, body: Buffer.alloc(0),
          };
          if (result.statusCode < 100 || result.statusCode > 599) {
            throw new DiagnosticError('UPSTREAM_ERROR', 'headers');
          }
          if (!options.body) {
            // Never attach a data listener, buffer, decompress, or drain HTTP bodies.
            succeed(result);
            return;
          }
          const contentTypes = headers.filter((header) => header.name.toLowerCase() === 'content-type');
          if (result.statusCode !== 200 || contentTypes.length !== 1
            || contentTypes[0]!.value.toLowerCase() !== 'application/dns-message'
            || headers.some((header) => header.name.toLowerCase() === 'content-encoding'
              && header.value.toLowerCase() !== 'identity')) {
            throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > SERVICE_LIMITS.dohBytes) {
              fail(new DiagnosticError('LIMIT_EXCEEDED', 'dns'));
            } else if (!settled) chunks.push(chunk);
          });
          res.once('aborted', () => fail(new DiagnosticError('UPSTREAM_ERROR', 'dns')));
          res.once('end', () => {
            if (!settled) succeed({ ...result, body: Buffer.concat(chunks, bytes) });
          });
        } catch (error) { fail(error); }
      });
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      else request.end(options.body);
    } catch (error) {
      if (!request) release();
      fail(error);
    }
  });
}

export type WireExchange = (body: Buffer, signal: AbortSignal) => Promise<Buffer>;
export function createWireExchange(limiter: ConnectionLimiter, requests = nativeRequests): WireExchange {
  return async (body, signal) => (await exchange({
    hostname: 'cloudflare-dns.com', address: '1.1.1.1', secure: true,
    path: '/dns-query', method: 'POST', signal, body,
  }, limiter, requests)).body;
}

export type PinnedTransport = (
  target: Target, address: string, method: 'HEAD' | 'GET', signal: AbortSignal,
) => Promise<Omit<HttpHop, 'url' | 'method' | 'durationMs' | 'location'>>;

export function createPinnedTransport(limiter: ConnectionLimiter, requests = nativeRequests): PinnedTransport {
  return async (target, address, method, signal) => {
    const { body: _discarded, ...result } = await exchange({
      hostname: target.hostname, address, secure: target.url.protocol === 'https:',
      path: `${target.url.pathname}${target.url.search}`, method, signal,
    }, limiter, requests);
    return result;
  };
}
