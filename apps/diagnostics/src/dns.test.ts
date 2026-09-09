import packet from 'dns-packet';
import { describe, expect, it, vi } from 'vitest';
import { LIMITS, dnsReportSchema } from '@domos/contracts';
import { DnsResolver, inspectDns } from './dns.js';
import { RequestBudget } from './limits.js';
import { answer, publicDns, wireFixture } from './fixtures.test-support.js';
import { queryName } from './public-policy.js';

const budget = (maximum: number = LIMITS.dnsQueries) => new RequestBudget(new AbortController().signal, maximum);

describe('controlled wire DNS', () => {
  it('decodes all eight types, TTLs and literal quoted TXT chunks', async () => {
    const resolver = new DnsResolver(wireFixture((name, type) => {
      const common = { name, ttl: 123, class: 'IN' as const };
      switch (type) {
        case 'A': return { answers: [{ ...common, type, data: '8.8.8.8' }] };
        case 'AAAA': return { answers: [{ ...common, type, data: '2001:4860:4860::8888' }] };
        case 'MX': return { answers: [{ ...common, type, data: { preference: 10, exchange: 'mail.example.com' } }] };
        case 'TXT': return { answers: [{ ...common, type, data: [Buffer.from('"quoted"'), Buffer.from('second\\chunk')] }] };
        case 'SOA': return { answers: [{ ...common, type, data: {
          mname: 'ns.example.com', rname: 'hostmaster.example.com',
          serial: 1, refresh: 2, retry: 3, expire: 4, minimum: 5,
        } }] };
        default: return { answers: [{ ...common, type, data: 'target.example.com' }] };
      }
    }));
    const result = await inspectDns({
      name: 'example.com', types: ['A', 'AAAA', 'MX', 'TXT', 'SOA', 'CNAME', 'NS', 'PTR'],
    }, resolver, budget());
    const data = dnsReportSchema.parse(result.data);
    expect(data.queries).toHaveLength(8);
    for (const query of data.queries) expect(query).toMatchObject({ status: 'answer', records: [{ ttl: 123 }] });
    expect(data.queries[3]).toMatchObject({ records: [{ chunks: ['"quoted"', 'second\\chunk'] }] });
    expect(result.error).toBeUndefined();
  });

  it('distinguishes NXDOMAIN, NODATA and SERVFAIL rather than reporting transient failure as absence', async () => {
    for (const [rcode, expected] of [[0, { status: 'negative', reason: 'NODATA' }],
      [3, { status: 'negative', reason: 'NXDOMAIN' }], [2, { status: 'error' }], [5, { status: 'error' }]] as const) {
      const resolver = new DnsResolver(wireFixture(() => ({ rcode })));
      expect(await resolver.lookup('example.com', 'A', budget())).toMatchObject({ rcode, ...expected });
    }
  });

  it('normalizes public PTR inputs and rejects private/full or abbreviated reverse zones', () => {
    expect(queryName('8.8.8.8', true)).toBe('8.8.8.8.in-addr.arpa');
    const v6 = queryName('2001:4860:4860::8888', true);
    expect(v6.split('.')).toHaveLength(34);
    expect(queryName(v6, true)).toBe(v6);
    for (const value of ['1.0.0.127.in-addr.arpa', '168.192.in-addr.arpa', '10.0.0.1', '::1', 'localhost', 'printer.local']) {
      expect(() => queryName(value, true)).toThrow();
    }
    expect(() => queryName('8.8.8.8', false)).toThrow();
  });

  it('does not accept mismatched questions, IDs, truncation, trailing bytes or malformed wire', async () => {
    for (const mutate of [
      (wire: Buffer) => { wire.writeUInt16BE(wire.readUInt16BE(0) ^ 1, 0); return wire; },
      (wire: Buffer) => { wire.writeUInt16BE(wire.readUInt16BE(2) | 0x0200, 2); return wire; },
      (wire: Buffer) => Buffer.concat([wire, Buffer.from([0])]),
      (_wire: Buffer) => Buffer.alloc(7),
      (_wire: Buffer) => Buffer.alloc(65_536),
    ]) {
      const resolver = new DnsResolver(async (body, signal) => mutate(await publicDns(body, signal)));
      expect(await resolver.lookup('example.com', 'A', budget())).toMatchObject({ status: 'error' });
    }
  });

  it('uses absolute query/deadline limits and passes cancellation into the wire adapter', async () => {
    const wire = vi.fn(publicDns);
    const resolver = new DnsResolver(wire);
    const limited = budget(1);
    expect((await resolver.lookup('example.com', 'A', limited)).status).toBe('answer');
    expect(await resolver.lookup('example.com', 'AAAA', limited)).toMatchObject({
      status: 'error', error: { code: 'LIMIT_EXCEEDED' },
    });
    expect(wire).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const waiting = new DnsResolver(async (_query, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const result = waiting.lookup('example.com', 'A', new RequestBudget(controller.signal, 16));
    controller.abort();
    expect(await result).toMatchObject({ status: 'error', error: { code: 'TIMEOUT' } });
  });

  it('bounds address sets and fails closed for mixed families, unresolved AAAA, aliases and rebinding', async () => {
    for (const wire of [
      wireFixture((name, type) => ({ answers: [answer(type, name, type === 'A' ? '8.8.8.8' : '::1')] })),
      wireFixture((name, type) => type === 'A' ? { answers: [answer('A', name, '8.8.8.8')] } : { rcode: 2 }),
      wireFixture((name) => ({ answers: [answer('CNAME', name, 'metadata.internal')] })),
      wireFixture((name) => ({ answers: [answer('CNAME', name, name)] })),
      wireFixture((name, type) => ({ answers: type === 'A'
        ? Array.from({ length: 17 }, (_value, index) => answer('A', name, `8.8.8.${index + 1}`)) : [] })),
    ]) await expect(new DnsResolver(wire).addresses('example.com', budget())).rejects.toThrow();
    let count = 0;
    const resolver = new DnsResolver(wireFixture((name, type) => ({
      answers: type === 'A' ? [answer('A', name, ++count === 1 ? '8.8.8.8' : '127.0.0.1')] : [],
    })));
    expect(await resolver.addresses('example.com', budget())).toEqual(['8.8.8.8']);
    await expect(resolver.addresses('example.com', budget())).rejects.toThrow();
  });

  it('follows CNAME through controlled requests, not the system resolver', async () => {
    const wire = vi.fn(wireFixture((name, type) => name === 'example.com'
      ? { answers: [answer('CNAME', name, 'target.example.com')] }
      : { answers: type === 'A' ? [answer('A', name, '8.8.8.8')] : [] }));
    expect(await new DnsResolver(wire).addresses('example.com', budget())).toEqual(['8.8.8.8']);
    expect(wire.mock.calls.map(([body]) => packet.decode(body).questions![0]!.name)).toEqual([
      'example.com', 'target.example.com', 'example.com', 'target.example.com',
    ]);
  });
});
