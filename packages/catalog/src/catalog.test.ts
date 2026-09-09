import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CATEGORIES, getTool, LIVE_TOOL_IDS, LOCAL_TOOL_IDS, PRIVACY_LABELS,
  TOOL_CATALOG, TOOL_IDS, TOOL_MODES,
} from './index.js';

describe('approved catalog', () => {
  it('contains exactly the approved sixteen IDs, with thirteen local and three live', () => {
    expect(TOOL_IDS).toEqual([
      'ipv4-subnet-planner', 'dns-explorer', 'email-dns-policy', 'http-inspector',
      'email-header-analyzer', 'chmod', 'password-generator', 'json-yaml-workbench',
      'base64', 'url-workbench', 'jwt-decoder', 'sha-checksums', 'regex-tester',
      'text-diff', 'cron-helper', 'epoch-time',
    ]);
    expect(new Set(TOOL_IDS).size).toBe(16);
    expect(LOCAL_TOOL_IDS).toHaveLength(13);
    expect(LIVE_TOOL_IDS).toEqual(['dns-explorer', 'email-dns-policy', 'http-inspector']);
    expect(Object.keys(TOOL_MODES)).toEqual([...TOOL_IDS]);
    expect(TOOL_CATALOG.map(({ id }) => id)).toEqual([...TOOL_IDS]);
  });

  it.each(TOOL_IDS)('%s has original metadata and deterministic route/guide paths', (id) => {
    const entry = getTool(id);
    expect(entry.title.length).toBeGreaterThan(3);
    expect(entry.description.length).toBeGreaterThan(40);
    expect(entry.guideTitle.length).toBeGreaterThan(20);
    expect(entry.toolPath).toBe(`/tools/${id}/`);
    expect(entry.guidePath).toBe(`/guides/${id}/`);
    expect(entry.category in CATEGORIES).toBe(true);
    expect(entry.mode).toBe(TOOL_MODES[id]);
    expect(entry.privacyLabel).toBe(PRIVACY_LABELS[TOOL_MODES[id]]);
    expect(entry.privacyDetail.length).toBeGreaterThan(40);
    expect(entry.icon).toMatch(/^[a-z-]+$/);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('keeps implementation and server code out of the metadata module', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bimport\s*(?:\(|[{*'"])/);
    expect(Object.isFrozen(TOOL_CATALOG)).toBe(true);
  });
});
