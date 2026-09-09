import { describe, expect, it } from 'vitest';
import { LIMITS, emailPolicyReportSchema } from '@domos/contracts';
import { DnsResolver } from './dns.js';
import { inspectEmail } from './email.js';
import { RequestBudget } from './limits.js';
import { answer, wireFixture } from './fixtures.test-support.js';

async function inspect(records: Record<string, string[] | 'SERVFAIL'>, domain = 'example.com', dkimSelector?: string) {
  const queried: string[] = [];
  const resolver = new DnsResolver(wireFixture((name) => {
    queried.push(name);
    const values = records[name];
    return values === 'SERVFAIL' ? { rcode: 2 }
      : { answers: (values ?? []).map((text) => answer('TXT', name, text)) };
  }));
  const result = await inspectEmail({ domain, ...(dkimSelector ? { dkimSelector } : {}) },
    resolver, new RequestBudget(new AbortController().signal, LIMITS.emailQueries));
  return { ...result, data: emailPolicyReportSchema.parse(result.data), queried };
}

describe('static email policy observations', () => {
  it('traverses includes/redirect with truthful query counts and explicit non-authentication', async () => {
    const result = await inspect({
      'example.com': ['v=spf1 include:example.net redirect=example.org'],
      'example.net': ['v=spf1 ip4:8.8.8.0/24 -all'], 'example.org': ['v=spf1 -all'],
      '_dmarc.example.com': ['v=DMARC1; p=reject; adkim=s; pct=100'],
    });
    expect(result.error).toBeUndefined();
    expect(result.data.spf).toMatchObject({ status: 'present', complete: true, lookupCount: 3 });
    expect(result.data.spf.dependencies).toHaveLength(2);
    expect(result.data.queriesUsed).toBe(4);
    expect(result.data.authentication).toBe('not-verified');
    expect(result.data.dmarc.policy).toBe('reject');
    expect(result.data.dkim.status).toBe('not-requested');
    expect(result.queried.every((name) => !name.includes('_domainkey'))).toBe(true);
  });

  it('detects cycles and retains macros without expanding or certifying SPF', async () => {
    const result = await inspect({
      'example.com': ['v=spf1 include:example.net include:%{d}.example.org -all'],
      'example.net': ['v=spf1 redirect=example.com'],
    });
    expect(result.data.spf).toMatchObject({ status: 'indeterminate', complete: false, lookupCount: 2 });
    expect(result.data.spf.dependencies.map((item) => item.status)).toContain('cycle');
    expect(result.data.spf.dependencies.map((item) => item.status)).toContain('macro');
    expect(result.queried.some((name) => name.includes('%'))).toBe(false);
  });

  it('accepts underscore SPF owners and distinguishes syntactic validity from public-scope restrictions', async () => {
    const valid = await inspect({
      'example.com': ['v=spf1 include:_spf.example.net a:%{l/}.example.com/24//64 -all'],
      '_spf.example.net': ['v=spf1 -all'],
    });
    expect(valid.data.spf).toMatchObject({ status: 'present', complete: true, lookupCount: 2 });
    expect(valid.queried).toContain('_spf.example.net');
    const blocked = await inspect({ 'example.com': ['v=spf1 include:mail.internal -all'] });
    expect(blocked.data.spf.status).toBe('indeterminate');
    expect(blocked.error?.code).toBe('TARGET_BLOCKED');
    expect(blocked.queried).not.toContain('mail.internal');
  });

  it('reports invalid static syntax with observed records, not absence', async () => {
    for (const text of ['v=spf1 ip4:999.1.1.1 -all', 'v=spf1 include: -all', 'v=spf1 mx/33 -all',
      'v=spf1 redirect=example.net redirect=example.org', 'v=spf1 unknown:thing']) {
      const result = await inspect({ 'example.com': [text] });
      expect(result.data.spf).toMatchObject({ status: 'invalid', records: [text] });
    }
  });

  it('bounds graph depth and total queries while preserving remaining policy observations', async () => {
    const records: Record<string, string[]> = {};
    for (let index = 0; index < 10; index++) records[`d${index}.example.com`] = [`v=spf1 include:d${index + 1}.example.com -all`];
    const result = await inspect(records, 'd0.example.com');
    expect(result.data.spf.complete).toBe(false);
    expect(result.data.spf.lookupCount).toBe(LIMITS.emailDepth + 1);
    expect(result.error?.code).toBe('LIMIT_EXCEEDED');
    expect(result.data.queriesUsed).toBeLessThanOrEqual(LIMITS.emailQueries);
    expect(result.data.spf.dependencies.at(-1)?.status).toBe('limit');

    const broad = await inspect({
      'example.com': [`v=spf1 ${Array.from({ length: 40 }, (_value, index) => `include:d${index}.example.net`).join(' ')} -all`],
    });
    expect(broad.error?.code).toBe('LIMIT_EXCEEDED');
    expect(broad.data.queriesUsed).toBeLessThanOrEqual(LIMITS.emailQueries);
    expect(broad.data.spf.dependencies.length).toBeLessThanOrEqual(LIMITS.emailQueries);
  });

  it('distinguishes missing policies from transient failures without inappropriate fallback', async () => {
    const missing = await inspect({});
    expect(missing.error).toBeUndefined();
    expect(missing.data.spf.status).toBe('absent');
    expect(missing.data.dmarc.status).toBe('absent');
    const failed = await inspect({
      'sub.example.com': ['v=spf1 include:example.net -all'], 'example.net': 'SERVFAIL',
      '_dmarc.sub.example.com': 'SERVFAIL', '_dmarc.example.com': ['v=DMARC1; p=reject'],
      'mail._domainkey.sub.example.com': 'SERVFAIL',
    }, 'sub.example.com', 'mail');
    expect(failed.error?.code).toBe('UPSTREAM_ERROR');
    expect(failed.data.spf).toMatchObject({ status: 'indeterminate', complete: false });
    expect(failed.data.dmarc.status).toBe('indeterminate');
    expect(failed.data.dkim.status).toBe('indeterminate');
    expect(failed.queried).not.toContain('_dmarc.example.com');
  });

  it('uses the public suffix library for organizational fallback and subdomain policy', async () => {
    const result = await inspect({ '_dmarc.example.co.uk': ['v=DMARC1; p=none; sp=reject'] }, 'mail.example.co.uk');
    expect(result.data.organizationalDomain).toBe('example.co.uk');
    expect(result.data.dmarc).toMatchObject({
      owner: '_dmarc.example.co.uk', organizationalFallback: true, status: 'present', policy: 'reject',
    });
    expect(result.queried).not.toContain('_dmarc.co.uk');
  });

  it('rejects invalid DMARC values and duplicates, with no fallback for an invalid record', async () => {
    for (const text of ['v=DMARC1; p=bad', 'v=DMARC1; pct=50', 'v=DMARC1; p=none; p=reject',
      'v=DMARC1; p=reject; pct=101', 'v=DMARC1; p=reject; adkim=bad']) {
      const result = await inspect({
        '_dmarc.sub.example.com': [text], '_dmarc.example.com': ['v=DMARC1; p=reject'],
      }, 'sub.example.com');
      expect(result.data.dmarc).toMatchObject({ status: 'invalid', records: [text], policy: null });
      expect(result.queried).not.toContain('_dmarc.example.com');
    }
  });

  it('recognizes intentionally revoked DKIM and queries only the supplied selector', async () => {
    const result = await inspect({ 'mail._domainkey.example.com': ['v=DKIM1; k=rsa; p='] }, 'example.com', 'mail');
    expect(result.data.dkim).toMatchObject({ status: 'present', selector: 'mail', findings: [{ code: 'DKIM_REVOKED' }] });
    expect(result.queried.filter((name) => name.includes('_domainkey'))).toEqual(['mail._domainkey.example.com']);
    const invalid = await inspect({ 'mail._domainkey.example.com': ['v=DKIM1; p=not:base64'] }, 'example.com', 'mail');
    expect(invalid.data.dkim).toMatchObject({ status: 'invalid', records: ['v=DKIM1; p=not:base64'] });
    const missing = await inspect({}, 'example.com', 'mail');
    expect(missing.data.dkim.status).toBe('absent');
  });
});
