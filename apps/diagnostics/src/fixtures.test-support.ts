import packet from 'dns-packet';
import type { DnsType, HttpHop } from '@domos/contracts';
import type { PinnedTransport, WireExchange } from './network.js';

export type DnsFixture = (name: string, type: DnsType) => {
  answers?: packet.Answer[]; rcode?: number;
};
export const answer = (type: DnsType, name: string, data: string): packet.StringAnswer | packet.TxtAnswer => {
  if (type === 'TXT') {
    const bytes = Buffer.from(data);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 255) chunks.push(bytes.subarray(offset, offset + 255));
    return { type, name, ttl: 300, class: 'IN', data: chunks.length ? chunks : [Buffer.alloc(0)] };
  }
  if (!['A', 'AAAA', 'CNAME', 'NS', 'PTR'].includes(type)) throw new Error('Unsupported fixture shorthand.');
  return { type: type as packet.StringRecordType, name, ttl: 300, class: 'IN', data };
};
export function wireFixture(fixture: DnsFixture): WireExchange {
  return async (body, signal) => {
    signal.throwIfAborted();
    const query = packet.decode(body);
    const question = query.questions![0]!;
    const reply = fixture(question.name, question.type as DnsType);
    return packet.encode({
      type: 'response', id: query.id, flags: packet.RECURSION_AVAILABLE | (reply.rcode ?? 0),
      questions: query.questions, answers: reply.answers ?? [],
    });
  };
}
export const publicDns: WireExchange = wireFixture((name, type) => ({
  answers: type === 'A' ? [answer('A', name, '8.8.8.8')] : [],
}));
export const headersTransport: PinnedTransport = async (_target, address) => ({
  statusCode: 200, remoteAddress: address,
  headers: [{ name: 'Server', value: 'fixture' }, { name: 'Set-Cookie', value: 'a=1' }, { name: 'Set-Cookie', value: 'b=2' }],
});
export const redirectHeaders = (location: string): HttpHop['headers'] => [{ name: 'Location', value: location }];
