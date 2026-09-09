import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pagePolicy } from '../../scripts/security-lib.mjs';
describe('production document CSP', () => {
  it('hashes real inline hydration code without unsafe script permissions', () => {
    const script = 'customElements.define("test-island",class extends HTMLElement{});';
    const policy = pagePolicy(`<html><head></head><body><script>${script}</script><script src="/_astro/client.js"></script></body></html>`);
    expect(policy.header).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    expect(policy.header).toContain("connect-src 'none'");
    expect(policy.header).toContain("worker-src 'self'");
    expect(policy.header).toContain("frame-ancestors 'none'");
    expect(policy.meta).not.toContain('frame-ancestors');
    expect(policy.header).not.toContain('unsafe-eval');
    expect(policy.header.split(';').find((part) => part.trim().startsWith('script-src'))).not.toContain('unsafe-inline');
  });
  it('only permits the compiled HTTPS API origin on live pages', () => {
    const policy = pagePolicy('<meta name="domos-processing-mode" content="live"><meta name="domos-api-origin" content="https://api.domosdigial.com">');
    expect(policy.header).toContain('connect-src https://api.domosdigial.com;');
    expect(() => pagePolicy('<meta name="domos-processing-mode" content="live">')).toThrow();
    expect(() => pagePolicy('<meta name="domos-processing-mode" content="live"><meta name="domos-api-origin" content="http://localhost:8787">')).toThrow();
  });
  it('refuses third-party scripts', () => {
    expect(() => pagePolicy('<script src="https://third-party.invalid/sdk.js"></script>')).toThrow('External script');
    expect(() => pagePolicy('<script src="//third-party.invalid/sdk.js"></script>')).toThrow('External script');
  });
});
