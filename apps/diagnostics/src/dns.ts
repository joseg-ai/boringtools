import { randomInt } from 'node:crypto';
import packet from 'dns-packet';
import {
  LIMITS, dnsRecordSchema, type DnsOutcome, type DnsRecord, type DnsReport, type DnsType,
  type ResolvedApiRequest,
} from '@domos/contracts';
import { RESOLVER, SERVICE_LIMITS } from './config.js';
import { DiagnosticError, checkAbort, safeError, type Observation } from './errors.js';
import { RequestBudget } from './limits.js';
import type { WireExchange } from './network.js';
import { publicAddress, publicName, queryName } from './public-policy.js';

const supported = new Set(['A', 'AAAA', 'MX', 'CNAME', 'NS', 'TXT', 'SOA', 'PTR']);
const normalize = (name: string) => name.toLowerCase().replace(/\.$/, '');

function record(answer: packet.Answer): DnsRecord | null {
  if (!supported.has(answer.type)) return null;
  if (!('ttl' in answer) || answer.class !== 'IN') throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
  const base = { name: answer.name, ttl: answer.ttl, type: answer.type };
  let value: unknown;
  switch (answer.type) {
    case 'A': case 'AAAA': value = { ...base, address: answer.data }; break;
    case 'CNAME': case 'NS': case 'PTR': value = { ...base, target: answer.data }; break;
    case 'MX': case 'SOA': value = { ...base, ...answer.data }; break;
    case 'TXT': {
      const chunks = Array.isArray(answer.data) ? answer.data : [answer.data];
      value = { ...base, chunks: chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk) };
      break;
    }
    default: return null;
  }
  const parsed = dnsRecordSchema.safeParse(value);
  if (!parsed.success) throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
  return parsed.data;
}

export class DnsResolver {
  constructor(private readonly wire: WireExchange) {}

  async lookup(name: string, type: DnsType, budget: RequestBudget): Promise<DnsOutcome> {
    let rcode: number | null = null;
    const signal = AbortSignal.any([budget.signal, AbortSignal.timeout(3000)]);
    try {
      queryName(name, type === 'PTR');
      budget.query();
      const id = randomInt(65_536);
      const query = packet.encode({
        type: 'query', id, flags: packet.RECURSION_DESIRED,
        questions: [{ name, type, class: 'IN' }],
      });
      const wire = await this.wire(query, signal);
      checkAbort(signal, 'dns');
      if (wire.length < 12 || wire.length > SERVICE_LIMITS.dohBytes) {
        throw new DiagnosticError('LIMIT_EXCEEDED', 'dns');
      }
      const count = wire.readUInt16BE(6) + wire.readUInt16BE(8) + wire.readUInt16BE(10);
      if (count > 256 || wire.readUInt16BE(6) > SERVICE_LIMITS.dnsRecords) {
        throw new DiagnosticError('LIMIT_EXCEEDED', 'dns');
      }
      const flags = wire.readUInt16BE(2);
      if (wire.readUInt16BE(0) !== id || wire.readUInt16BE(4) !== 1
        || (flags & 0x8000) === 0 || (flags & 0x7800) !== 0 || (flags & 0x0200) !== 0) {
        throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
      }
      const decoded = packet.decode(wire);
      if (packet.decode.bytes !== wire.length || decoded.questions?.length !== 1
        || normalize(decoded.questions[0]!.name) !== normalize(name)
        || decoded.questions[0]!.type !== type || decoded.questions[0]!.class !== 'IN'
        || decoded.additionals?.some((answer) => answer.type === 'OPT' && answer.extendedRcode !== 0)) {
        throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
      }
      rcode = flags & 15;
      if (rcode !== 0 && rcode !== 3) throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
      if (rcode === 3) return { type, status: 'negative', reason: 'NXDOMAIN', rcode: 3 };
      const records = (decoded.answers ?? []).map(record).filter((item) => item !== null);
      return records.length
        ? { type, status: 'answer', rcode: 0, records }
        : { type, status: 'negative', reason: 'NODATA', rcode: 0 };
    } catch (error) {
      return { type, status: 'error', rcode, error: safeError(error, 'dns', signal) };
    }
  }

  async addresses(name: string, budget: RequestBudget, deniedHosts: readonly string[] = []): Promise<string[]> {
    const values: string[] = [];
    for (const type of ['A', 'AAAA'] as const) {
      let current = publicName(name, false);
      const seen = new Set<string>();
      while (true) {
        if (deniedHosts.some((host) => current === host || current.endsWith(`.${host}`))) {
          throw new DiagnosticError('TARGET_BLOCKED', 'policy');
        }
        if (seen.has(current)) throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
        seen.add(current);
        const outcome = await this.lookup(current, type, budget);
        if (outcome.status === 'error') throw new DiagnosticError(outcome.error.code, outcome.error.phase);
        if (outcome.status === 'negative') {
          // NXDOMAIN is incompatible with addresses in the other family.
          if (outcome.reason === 'NXDOMAIN') throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
          break;
        }
        // Reject private data anywhere in the answer, including another family
        // or unrelated additional answer records. Never select a "good" subset.
        for (const item of outcome.records) {
          if (item.type === 'A' || item.type === 'AAAA') publicAddress(item.address);
        }
        const aliases = outcome.records.filter((item) => item.type === 'CNAME' && normalize(item.name) === current);
        const found = outcome.records.filter((item) => item.type === type && normalize(item.name) === current);
        if (aliases.length > 1 || (aliases.length && found.length)) throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
        if (found.length) {
          for (const item of found) {
            if (item.type === 'A' || item.type === 'AAAA') values.push(publicAddress(item.address));
          }
          break;
        }
        const alias = aliases[0];
        if (!alias || alias.type !== 'CNAME') throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
        // Re-query every alias through controlled DoH; do not trust unrelated RRs.
        current = publicName(alias.target);
      }
    }
    if (!values.length) throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
    if (values.length > LIMITS.httpAddresses) throw new DiagnosticError('LIMIT_EXCEEDED', 'dns');
    return [...new Set(values)];
  }
}

export async function inspectDns(
  request: ResolvedApiRequest<'dns'>, resolver: DnsResolver, budget: RequestBudget,
): Promise<Observation<DnsReport>> {
  const name = queryName(request.name, request.types.length === 1 && request.types[0] === 'PTR');
  const queries: DnsOutcome[] = [];
  for (const type of request.types) queries.push(await resolver.lookup(name, type, budget));
  const data: DnsReport = { name, resolver: RESOLVER, queries };
  const error = queries.find((outcome) => outcome.status === 'error');
  if (error?.status === 'error' && queries.every((outcome) => outcome.status === 'error' && outcome.rcode === null)) {
    throw new DiagnosticError(error.error.code, error.error.phase);
  }
  return error?.status === 'error' ? { data, error: error.error } : { data };
}
