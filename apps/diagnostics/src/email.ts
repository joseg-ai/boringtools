import { isIP } from 'node:net';
import { parse as parseDomain } from 'tldts';
import {
  LIMITS, dnsNameSchema, type ApiError, type DkimReport, type DmarcReport, type EmailPolicyReport,
  type PolicyFinding, type ResolvedApiRequest, type SpfReport,
} from '@domos/contracts';
import { RESOLVER } from './config.js';
import { DnsResolver } from './dns.js';
import { DiagnosticError, failure, safeError, type Observation } from './errors.js';
import { RequestBudget } from './limits.js';
import { publicName } from './public-policy.js';

interface TxtObservation { records: string[]; failed: boolean }
const finding = (code: string, message: string, severity: PolicyFinding['severity'] = 'warning'): PolicyFinding =>
  ({ code, message, severity });

class EmailDns {
  evidence: EmailPolicyReport['evidence'] = [];
  error: ApiError | undefined;
  private cache = new Map<string, TxtObservation>();
  private evidenceBytes = 0;
  constructor(readonly resolver: DnsResolver, readonly budget: RequestBudget) {}

  stop(error: ApiError): void { this.error ??= error; }

  async txt(owner: string): Promise<TxtObservation> {
    const initial = owner;
    const cached = this.cache.get(initial);
    if (cached) return cached;
    const seen = new Set<string>();
    try {
      while (true) {
        owner = publicName(owner);
        if (seen.has(owner)) throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
        seen.add(owner);
        const before = this.budget.queries;
        const outcome = await this.resolver.lookup(owner, 'TXT', this.budget);
        if (this.budget.queries > before) {
          this.evidenceBytes += Buffer.byteLength(JSON.stringify(outcome));
          if (this.evidenceBytes > 160 * 1024) throw new DiagnosticError('LIMIT_EXCEEDED', 'dns');
          this.evidence.push({ name: owner, outcome });
        }
        if (outcome.status === 'error') throw new DiagnosticError(outcome.error.code, outcome.error.phase);
        if (outcome.status === 'negative') {
          const result = { records: [], failed: false };
          this.cache.set(initial, result);
          return result;
        }
        const records = outcome.records.filter((record) => record.type === 'TXT'
          && record.name.toLowerCase().replace(/\.$/, '') === owner)
          .map((record) => record.type === 'TXT' ? record.chunks.join('') : '');
        if (records.length > 32 || records.some((record) => Buffer.byteLength(record) > 16_384)) {
          throw new DiagnosticError('LIMIT_EXCEEDED', 'dns');
        }
        const aliases = outcome.records.filter((record) => record.type === 'CNAME'
          && record.name.toLowerCase().replace(/\.$/, '') === owner);
        if (aliases.length > 1 || (aliases.length && records.length)) {
          throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
        }
        if (records.length) {
          const result = { records, failed: false };
          this.cache.set(initial, result);
          return result;
        }
        const alias = aliases[0];
        if (!alias || alias.type !== 'CNAME') throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
        owner = alias.target;
      }
    } catch (error) {
      this.stop(safeError(error, 'dns', this.budget.signal));
      return { records: [], failed: true };
    }
  }
}

interface SpfSyntax {
  valid: boolean;
  links: { to: string; mechanism: 'include' | 'redirect' }[];
  unevaluated: string[];
  findings: PolicyFinding[];
}

function domainSpec(value: string): boolean {
  if (!value || value.length > 1024) return false;
  if (!value.includes('%')) return dnsNameSchema.safeParse(value).success;
  return /^(?:[a-zA-Z0-9._:-]|%%|%_|%-|%\{[slodipvhSLODIPVH]\d*r?[.\-+,/_=]*\})+$/u
    .test(value) && !value.includes(' ');
}

function spfSyntax(text: string): SpfSyntax {
  const result: SpfSyntax = { valid: true, links: [], unevaluated: [], findings: [] };
  const terms = text.split(/[ \t]+/);
  const modifiers = new Set<string>();
  if (terms.shift()?.toLowerCase() !== 'v=spf1' || /[^\x20-\x7e\t]/.test(text)) result.valid = false;
  if (terms.length > 100) {
    result.valid = false;
    result.findings.push(finding('SPF_TERM_LIMIT', 'Static syntax inspection is limited to 100 terms.', 'error'));
    return result;
  }
  for (const token of terms) {
    if (!token) continue;
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(token);
    if (modifier) {
      const key = modifier[1]!.toLowerCase();
      const value = modifier[2]!;
      if (modifiers.has(key) || !value) result.valid = false;
      modifiers.add(key);
      if (key === 'redirect') {
        if (!domainSpec(value)) result.valid = false;
        else result.links.push({ to: value, mechanism: 'redirect' });
      } else if (key === 'exp') {
        if (!domainSpec(value)) result.valid = false;
        result.unevaluated.push('SPF exp requires evaluation context and was not fetched.');
      } else result.findings.push(finding('SPF_UNKNOWN_MODIFIER', 'An extension modifier was not evaluated.', 'info'));
      continue;
    }
    const term = token.replace(/^[+?~-]/, '');
    if (term.toLowerCase() === 'all') continue;
    const link = /^(include|exists):(.+)$/i.exec(term);
    if (link) {
      if (!domainSpec(link[2]!)) result.valid = false;
      else if (link[1]!.toLowerCase() === 'include') result.links.push({ to: link[2]!, mechanism: 'include' });
      else result.unevaluated.push('SPF exists requires sender context and was not evaluated.');
      continue;
    }
    const ip = /^(ip4|ip6):([^/]+)(?:\/(\d{1,3}))?$/i.exec(term);
    if (ip) {
      const v4 = ip[1]!.toLowerCase() === 'ip4';
      if (isIP(ip[2]!) !== (v4 ? 4 : 6) || ip[2]!.includes('%')
        || (ip[3] !== undefined && Number(ip[3]) > (v4 ? 32 : 128))) result.valid = false;
      continue;
    }
    const address = /^(a|mx)(?::((?:%\{[^}]*\}|[^/])+))?(?:\/(\d{1,2}))?(?:\/\/(\d{1,3}))?$/i.exec(term);
    if (address) {
      if ((address[2] && !domainSpec(address[2])) || Number(address[3] ?? 0) > 32
        || Number(address[4] ?? 0) > 128) result.valid = false;
      result.unevaluated.push('SPF a/mx mechanisms require sender context and were not evaluated.');
      continue;
    }
    const ptr = /^ptr(?::(.+))?$/i.exec(term);
    if (ptr) {
      if (ptr[1] && !domainSpec(ptr[1])) result.valid = false;
      result.unevaluated.push('SPF ptr requires sender context and was not evaluated.');
      result.findings.push(finding('SPF_PTR_DISCOURAGED', 'The SPF ptr mechanism is discouraged.'));
      continue;
    }
    result.valid = false;
  }
  if (!result.valid) result.findings.push(finding('SPF_SYNTAX', 'The observed SPF record has unsupported or invalid syntax.', 'error'));
  return result;
}

async function inspectSpf(domain: string, dns: EmailDns): Promise<SpfReport> {
  const startQueries = dns.budget.queries;
  const report: SpfReport = {
    owner: domain, status: 'absent', records: [], findings: [], dependencies: [],
    lookupCount: 0, complete: true, unevaluated: [],
  };
  const active = new Set<string>();
  const visited = new Set<string>();
  const incomplete = () => {
    report.complete = false;
    if (report.status === 'present') report.status = 'indeterminate';
  };
  const walk = async (owner: string, depth: number): Promise<boolean> => {
    const observation = await dns.txt(owner);
    const records = observation.records.filter((text) => /^v=spf1/i.test(text));
    if (depth === 0) report.records = records;
    if (observation.failed) {
      incomplete();
      if (depth === 0) report.status = 'indeterminate';
      return false;
    }
    if (records.length === 0) {
      if (depth > 0) {
        incomplete();
        report.findings.push(finding('SPF_DEPENDENCY_ABSENT', 'A referenced SPF policy is absent.', 'error'));
      }
      return true;
    }
    if (depth === 0) report.status = 'present';
    if (records.length !== 1) {
      if (depth === 0) report.status = 'invalid';
      incomplete();
      report.findings.push(finding('SPF_MULTIPLE_RECORDS', 'Multiple SPF policies were observed at one owner.', 'error'));
      return true;
    }
    const syntax = spfSyntax(records[0]!);
    report.findings.push(...syntax.findings);
    report.unevaluated.push(...syntax.unevaluated);
    if (!syntax.valid) {
      if (depth === 0) report.status = 'invalid';
      incomplete();
      return true;
    }
    active.add(owner);
    for (const link of syntax.links) {
      if (report.dependencies.length >= LIMITS.emailQueries) {
        incomplete();
        dns.stop(failure('LIMIT_EXCEEDED', 'dns'));
        break;
      }
      const dependency: SpfReport['dependencies'][number] = { from: owner, ...link, status: 'observed' };
      report.dependencies.push(dependency);
      if (link.to.includes('%')) {
        dependency.status = 'macro';
        incomplete();
        report.unevaluated.push('An SPF include/redirect macro was retained without expansion.');
        continue;
      }
      let target: string;
      try { target = publicName(link.to); } catch {
        dependency.status = 'unresolved';
        incomplete();
        dns.stop(failure('TARGET_BLOCKED', 'policy'));
        continue;
      }
      if (active.has(target)) {
        dependency.status = 'cycle';
        incomplete();
        report.findings.push(finding('SPF_CYCLE', 'The static SPF include/redirect graph contains a cycle.'));
      } else if (depth >= LIMITS.emailDepth || dns.budget.queries >= LIMITS.emailQueries - 3) {
        // Reserve requests for DMARC and the explicit DKIM selector.
        dependency.status = 'limit';
        incomplete();
        dns.stop(failure('LIMIT_EXCEEDED', 'dns'));
      } else if (!visited.has(target)) {
        const observed = await walk(target, depth + 1);
        if (!observed) {
          dependency.status = 'unresolved';
          incomplete();
        }
      }
    }
    active.delete(owner);
    visited.add(owner);
    return true;
  };
  await walk(domain, 0);
  report.lookupCount = dns.budget.queries - startQueries;
  report.unevaluated = [...new Set(report.unevaluated)].slice(0, 100);
  if (report.findings.length > 100) {
    report.findings = report.findings.slice(0, 99);
    report.findings.push(finding('FINDINGS_LIMIT', 'Additional findings exceeded the report budget.'));
    incomplete();
    dns.stop(failure('LIMIT_EXCEEDED', 'dns'));
  }
  return report;
}

function tags(text: string): Map<string, string> | null {
  if (/[^\x20-\x7e\t]/.test(text)) return null;
  const result = new Map<string, string>();
  const parts = text.split(';');
  if (parts.at(-1)?.trim() === '') parts.pop();
  for (const part of parts) {
    const match = /^\s*([a-z][a-z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(part);
    if (!match) return null;
    const key = match[1]!;
    if (result.has(key)) return null;
    result.set(key, match[2]!);
  }
  return result;
}

const policies = new Set(['none', 'quarantine', 'reject']);
function policy(value: string | undefined): DmarcReport['policy'] {
  return value === 'none' || value === 'quarantine' || value === 'reject' ? value : null;
}

function validDmarc(record: string, parsed: Map<string, string>): boolean {
  if (!/^v=DMARC1\s*;/.test(record) || parsed.get('v') !== 'DMARC1'
    || !policies.has(parsed.get('p') ?? '')) return false;
  for (const [key, value] of parsed) {
    if (key === 'sp' && !policies.has(value)) return false;
    if ((key === 'adkim' || key === 'aspf') && !['r', 's'].includes(value)) return false;
    if (key === 'pct' && (!/^\d{1,3}$/.test(value) || Number(value) > 100)) return false;
    if (key === 'ri' && (!/^\d{1,10}$/.test(value) || Number(value) > 4_294_967_295)) return false;
    if (key === 'fo' && !/^[01ds](?::[01ds])*$/.test(value)) return false;
    if (key === 'rf' && !/^[a-z0-9-]+(?::[a-z0-9-]+)*$/.test(value)) return false;
    if ((key === 'rua' || key === 'ruf') && !value.split(',').every((uri) =>
      /^mailto:[^\s@,]+@[^\s@,]+(?:!\d+[kmgt]?)?$/.test(uri.trim()))) return false;
  }
  return true;
}

async function inspectDmarc(domain: string, organizational: string | null, dns: EmailDns): Promise<DmarcReport> {
  const report: DmarcReport = {
    owner: `_dmarc.${domain}`, status: 'absent', records: [], findings: [],
    policy: null, organizationalFallback: false,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const observation = await dns.txt(report.owner);
    if (observation.failed) {
      report.status = 'indeterminate';
      report.findings.push(finding('DMARC_DNS_ERROR', 'DMARC could not be determined because DNS failed.'));
      return report;
    }
    report.records = observation.records.filter((text) => /^\s*v\s*=\s*DMARC1/i.test(text));
    if (report.records.length) {
      const parsed = report.records.length === 1 ? tags(report.records[0]!) : null;
      if (!parsed || !validDmarc(report.records[0]!, parsed)) {
        report.status = 'invalid';
        report.findings.push(finding('DMARC_SYNTAX', 'Multiple or invalid DMARC policies were observed.', 'error'));
      } else {
        report.status = 'present';
        report.policy = policy(report.organizationalFallback ? parsed.get('sp') ?? parsed.get('p') : parsed.get('p'));
      }
      return report;
    }
    if (attempt === 0 && organizational && organizational !== domain) {
      report.owner = `_dmarc.${organizational}`;
      report.organizationalFallback = true;
    } else break;
  }
  if (!organizational && report.status === 'absent') {
    report.status = 'indeterminate';
    report.findings.push(finding('DMARC_ORGANIZATIONAL_DOMAIN_UNKNOWN',
      'No organizational domain is available from the installed ICANN public suffix list; fallback is indeterminate.'));
  }
  return report;
}

async function inspectDkim(domain: string, selector: string | undefined, dns: EmailDns): Promise<DkimReport> {
  if (!selector) return { status: 'not-requested', owner: null, selector: null, records: [], findings: [] };
  const owner = `${selector}._domainkey.${domain}`;
  const report: DkimReport = { owner, selector, status: 'absent', records: [], findings: [] };
  const observation = await dns.txt(owner);
  if (observation.failed) {
    report.status = 'indeterminate';
    report.findings.push(finding('DKIM_DNS_ERROR', 'The supplied DKIM selector could not be determined because DNS failed.'));
    return report;
  }
  report.records = observation.records;
  if (!report.records.length) return report;
  const parsed = report.records.length === 1 ? tags(report.records[0]!) : null;
  const key = parsed?.get('p')?.replace(/[ \t]/g, '');
  const validKey = key !== undefined && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(key);
  const algorithm = parsed?.get('k') ?? 'rsa';
  const valid = parsed && validKey && ['rsa', 'ed25519'].includes(algorithm)
    && (!parsed.has('v') || (parsed.get('v') === 'DKIM1' && parsed.keys().next().value === 'v'))
    && (!parsed.has('h') || /^(?:sha1|sha256)(?::(?:sha1|sha256))*$/.test(parsed.get('h')!))
    && (!parsed.has('t') || /^[ys](?::[ys])*$/.test(parsed.get('t')!))
    && (!parsed.has('s') || /^(?:\*|email)(?::(?:\*|email))*$/.test(parsed.get('s')!))
    && (algorithm !== 'ed25519' || key === '' || Buffer.from(key!, 'base64').length === 32);
  if (!valid) {
    report.status = 'invalid';
    report.findings.push(finding('DKIM_SYNTAX', 'The supplied selector has multiple records or invalid key-record syntax.', 'error'));
  } else {
    report.status = 'present';
    if (key === '') report.findings.push(finding('DKIM_REVOKED', 'The selector is explicitly revoked (empty p tag).'));
  }
  return report;
}

export async function inspectEmail(
  request: ResolvedApiRequest<'emailPolicy'>, resolver: DnsResolver, budget: RequestBudget,
): Promise<Observation<EmailPolicyReport>> {
  const domain = publicName(request.domain, false);
  const selector = request.dkimSelector?.toLowerCase().replace(/\.$/, '');
  if (selector) publicName(`${selector}._domainkey.${domain}`);
  publicName(`_dmarc.${domain}`);
  const parsed = parseDomain(domain, { allowPrivateDomains: false });
  const organizationalDomain = parsed.isIcann ? parsed.domain : null;
  const dns = new EmailDns(resolver, budget);
  const spf = await inspectSpf(domain, dns);
  const dmarc = await inspectDmarc(domain, organizationalDomain, dns);
  const dkim = await inspectDkim(domain, selector, dns);
  const data: EmailPolicyReport = {
    domain, organizationalDomain, resolver: RESOLVER, spf, dmarc, dkim,
    evidence: dns.evidence, queriesUsed: budget.queries, queryBudget: LIMITS.emailQueries,
    limitations: [
      'DNS records only: no message authentication, deliverability or security score.',
      'SPF is static syntax and include/redirect graph exploration, not sender evaluation or RFC 7208 ten-term certification.',
      'SPF lookupCount counts attempted exploration DNS requests, including failures and CNAME traversal; macros are never expanded.',
      'SPF a, mx, ptr, exists and exp are not evaluated; complete concerns only the inspected static include/redirect graph.',
      'DMARC organizational fallback uses the installed tldts ICANN public suffix list, not private suffixes or DNS tree walking.',
      'DKIM is inspected only at the supplied selector; cryptographic key validity and message signatures are not verified.',
      'External DMARC reporting authorization is not checked. No DNSSEC validation claim is made.',
    ],
    evaluationScope: 'dns-records-only', authentication: 'not-verified',
  };
  return dns.error ? { data, error: dns.error } : { data };
}
