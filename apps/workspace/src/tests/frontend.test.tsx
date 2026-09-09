import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TOOL_CATALOG, TOOL_IDS } from '@domos/catalog';
import { LIMITS } from '@domos/contracts';
import ToolWorkspace from '../components/ToolWorkspace';
import { requestLive, SERVICE_ACTIVATION_ALLOWANCE_MS } from '../lib/api-client';
import { GUIDES } from '../../../site/src/data/guides';
import Directory from '../../../site/src/components/Directory';
import { TextResult } from '../components/ui';
vi.mock('../config', () => ({ API_ORIGIN: 'https://api.domosdigial.com' }));
afterEach(() => vi.unstubAllGlobals());
const meta = { requestId: 'frontend-fixture', observedAt: '2026-01-01T00:00:00Z', elapsedMs: 10, policyVersion: 'v1' };
const report = { kind: 'result', data: { name: 'example.com', resolver: 'fixture', queries: [{ type: 'A', status: 'negative', reason: 'NODATA', rcode: 0 }] }, meta };
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('complete frontend surfaces', () => {
  it('renders distinct controls for all sixteen tools without executing or fetching', () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const id of TOOL_IDS) {
      const html = renderToStaticMarkup(<ToolWorkspace id={id} />);
      expect(html).toContain('Clear / reset');
      expect(html).toContain('<form');
      expect(html).not.toContain('Foundation');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps JWT and email-header results visibly unverified', () => {
    expect(renderToStaticMarkup(<ToolWorkspace id="jwt-decoder" />)).toContain('UNVERIFIED');
    expect(renderToStaticMarkup(<ToolWorkspace id="email-header-analyzer" />)).toContain('Reported, not verified');
  });
  it('renders hostile tool values as literal text', () => {
    const html = renderToStaticMarkup(<TextResult text={'<img src="https://example.com" onerror="alert(1)">'} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
  it('provides original substantial guide content for the fixed catalog', () => {
    expect(Object.keys(GUIDES).sort()).toEqual([...TOOL_IDS].sort());
    for (const guide of Object.values(GUIDES)) {
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.pitfalls.length).toBe(3);
      expect(Object.values(guide).flat().join(' ').length).toBeGreaterThan(900);
    }
  });
  it('renders working document links for both deployment origins', () => {
    for (const origin of ['http://localhost:4322', 'https://tools.domosdigial.com']) {
      const html = renderToStaticMarkup(<Directory workspaceOrigin={origin} />);
      for (const tool of TOOL_CATALOG) {
        expect(html).toContain(`href="${origin}${tool.toolPath}"`);
        expect(html).toContain(`href="${tool.guidePath}"`);
      }
    }
  });
});
describe('bounded explicit API transport', () => {
  it('allows bounded scale-to-zero activation without changing API inspection deadlines', () => {
    expect(SERVICE_ACTIVATION_ALLOWANCE_MS).toBe(45_000);
    for (const timeout of [LIMITS.dnsTimeoutMs, LIMITS.emailTimeoutMs, LIMITS.httpTimeoutMs]) {
      expect(timeout + SERVICE_ACTIVATION_ALLOWANCE_MS).toBeLessThanOrEqual(60_000);
    }
  });
  it('posts to the configured origin without credentials or URL query inputs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(report)); vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const result = await requestLive('dns', { name: 'example.com', types: ['A'] }, signal);
    expect(result.kind).toBe('result');
    expect(fetchMock).toHaveBeenCalledWith('https://api.domosdigial.com/api/v1/dns', expect.objectContaining({
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
      body: '{"name":"example.com","types":["A"]}',
    }));
  });
  it('rejects invalid input before making any request', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(requestLive('dns', { name: '', types: [] }, new AbortController().signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves partial reports and their upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...report, kind: 'partial', error: { code: 'TIMEOUT', phase: 'dns', message: 'Resolver deadline' } })));
    const result = await requestLive('dns', { name: 'example.com', types: ['A'] }, new AbortController().signal);
    expect(result.kind).toBe('partial');
    if (result.kind === 'partial') expect(result.error.message).toBe('Resolver deadline');
  });
  it('rejects malformed and mismatched response envelopes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...report, extra: true })));
    await expect(requestLive('dns', { name: 'example.com', types: ['A'] }, new AbortController().signal)).rejects.toThrow('contract');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(report, 502)));
    await expect(requestLive('dns', { name: 'example.com', types: ['A'] }, new AbortController().signal)).rejects.toThrow('HTTP status');
  });
  it('bounds a streamed response even without Content-Length', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(LIMITS.apiResponseBytes + 1), { headers: { 'Content-Type': 'application/json' } })));
    await expect(requestLive('dns', { name: 'example.com', types: ['A'] }, new AbortController().signal)).rejects.toThrow('allowed size');
  });
});
