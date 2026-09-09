import { describe, expect, it, vi } from 'vitest';
import { LIMITS, httpReportSchema } from '@domos/contracts';
import { DnsResolver } from './dns.js';
import { inspectHttp } from './http.js';
import { DiagnosticError } from './errors.js';
import { RequestBudget } from './limits.js';
import { answer, headersTransport, publicDns, redirectHeaders, wireFixture } from './fixtures.test-support.js';
import { httpTarget, publicAddress } from './public-policy.js';
import type { PinnedTransport } from './network.js';

const budget = () => new RequestBudget(new AbortController().signal, LIMITS.dnsQueries);
const resolver = () => new DnsResolver(publicDns);

describe('HTTP public target policy', () => {
  it.each([
    'http://127.0.0.1', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://127.000.0.1', 'http://[::1]', 'http://[::ffff:8.8.8.8]', 'http://[fe80::1%25eth0]',
    'http://user:pass@example.com', 'http://example.com:8080', 'https://example.com:80',
    'http://example.com:443', 'http://example.com:080', 'http://example.com:',
    'http://example.com\\@127.0.0.1', 'http://%65xample.com', 'http://example.com.',
    'http:///example.com', 'https:example.com', 'http://example.com\n', 'http://example.com/%0aheader',
    'http://169.254.169.254', 'http://168.63.129.16', 'http://100.100.100.200',
    'http://metadata.internal', 'http://single-label', 'http://foo.local', 'http://foo.home.arpa',
    'http://example.com\u0000', 'http://[2001:04860:4860::8888]', 'https://api.domosdigial.com',
    'https://tools.domosdigial.com', 'https://domosdigial.com',
  ])('rejects unsafe or normalized authority %s', (url) => {
    expect(() => httpTarget(url, ['domosdigial.com'])).toThrow();
  });

  it.each([
    '0.1.2.3', '10.0.0.1', '172.31.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1',
    '169.254.0.1', '168.63.129.16', '192.0.0.9', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '198.18.0.1', '192.88.99.1', '192.52.193.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '64:ff9b:1::808:808', '2002:808:808::1',
    '2001::1', '2001:20::1', '2001:db8::1', '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '4000::1', '2001:4860:4860:1:0:5efe:808:808',
  ])('blocks special address %s', (address) => expect(() => publicAddress(address)).toThrow());

  it('allows only canonical public IPs/hostnames, normalizes path and removes fragments', () => {
    expect(httpTarget('https://Example.COM:443/a/../b?x=1#fragment', []).url.href).toBe('https://example.com/b?x=1');
    expect(httpTarget('https://[2001:4860:4860::8888]/', []).literal).toBe('2001:4860:4860::8888');
    expect(httpTarget('http://8.8.8.8:80/', []).literal).toBe('8.8.8.8');
  });

  it('never performs a GET fallback and stores duplicate headers only as data', async () => {
    const transport = vi.fn(headersTransport);
    const result = await inspectHttp({ url: 'https://example.com', method: 'HEAD' }, resolver(), transport, budget(), []);
    expect(httpReportSchema.parse(result.data).hops[0]!.headers.filter((item) => item.name === 'Set-Cookie')).toHaveLength(2);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![2]).toBe('HEAD');
  });

  it('preserves observed hops when a redirect is private, downgrades TLS or exploits parser normalization', async () => {
    for (const location of [
      'http://127.0.0.1', '//127.1', 'http://example.net', '//%65xample.net',
      'https://example.net\\@127.0.0.1', 'https://user:pass@example.net',
    ]) {
      const transport = vi.fn<PinnedTransport>(async (_target, address) => ({
        remoteAddress: address, statusCode: 302, headers: redirectHeaders(location),
      }));
      const result = await inspectHttp({ url: 'https://example.com', method: 'HEAD' }, resolver(), transport, budget(), []);
      expect(httpReportSchema.parse(result.data)).toMatchObject({ termination: 'blocked', hops: [{ statusCode: 302 }] });
      expect(result.error?.code).toBe('TARGET_BLOCKED');
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds redirects at five and detects loops, preserving GET when explicitly requested', async () => {
    const transport = vi.fn<PinnedTransport>(async (target, address) => ({
      remoteAddress: address, statusCode: 302, headers: redirectHeaders(`/hop${Number(target.url.pathname.slice(4) || '0') + 1}`),
    }));
    const result = await inspectHttp({ url: 'https://example.com/hop0', method: 'GET' }, resolver(), transport, budget(), []);
    expect(result.data.termination).toBe('redirect-limit');
    expect(result.data.hops).toHaveLength(6);
    expect(transport.mock.calls.every((call) => call[2] === 'GET')).toBe(true);
    const loop: PinnedTransport = async (_target, address) => ({ remoteAddress: address, statusCode: 301, headers: redirectHeaders('/') });
    const looping = await inspectHttp({ url: 'https://example.com/', method: 'HEAD' }, resolver(), loop, budget(), []);
    expect(looping.data.termination).toBe('redirect-loop');
    expect(looping.data.hops).toHaveLength(1);
  });

  it('reports later TLS/time failures as partial and redacts arbitrary transport errors', async () => {
    for (const error of [new DiagnosticError('TIMEOUT', 'headers'), new DiagnosticError('UPSTREAM_ERROR', 'tls'),
      new Error('SECRET target and Authorization header')]) {
      let calls = 0;
      const transport: PinnedTransport = async (_target, address) => {
        if (++calls === 2) throw error;
        return { remoteAddress: address, statusCode: 302, headers: redirectHeaders('/next') };
      };
      const result = await inspectHttp({ url: 'https://example.com', method: 'HEAD' }, resolver(), transport, budget(), []);
      expect(result.data.hops).toHaveLength(1);
      expect(result.error).toBeDefined();
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(httpReportSchema.safeParse(result.data).success).toBe(true);
    }
  });

  it('rejects a mismatched connected peer even from an injected transport', async () => {
    const transport: PinnedTransport = async () => ({ remoteAddress: '1.1.1.1', statusCode: 200, headers: [] });
    await expect(inspectHttp({ url: 'https://example.com', method: 'HEAD' },
      resolver(), transport, budget(), [])).rejects.toThrow();
  });

  it('re-resolves redirect hosts and keeps the earlier hop when DNS rebinds to a private IP', async () => {
    let lookups = 0;
    const changing = new DnsResolver(wireFixture((name, type) => ({
      answers: type === 'A' ? [answer('A', name, ++lookups === 1 ? '8.8.8.8' : '127.0.0.1')] : [],
    })));
    const transport = vi.fn<PinnedTransport>(async (_target, address) => ({
      remoteAddress: address, statusCode: 302, headers: redirectHeaders('/rebound'),
    }));
    const result = await inspectHttp({ url: 'https://example.com', method: 'HEAD' }, changing, transport, budget(), []);
    expect(result.data).toMatchObject({ termination: 'blocked', hops: [{ remoteAddress: '8.8.8.8' }] });
    expect(result.data.hops).toHaveLength(1);
    expect(result.error?.code).toBe('TARGET_BLOCKED');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(httpReportSchema.safeParse(result.data).success).toBe(true);
  });
});
