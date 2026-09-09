import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isMap, isSeq, parseDocument } from 'yaml';
import { testOrigins } from './origins';
import browserConfig from '../../../playwright.config';

describe('release test wiring', () => {
  it('accepts explicit loopback test origins without changing canonical production origins', () => {
    expect(testOrigins({
      E2E_SITE_ORIGIN: 'http://127.0.0.1:4431',
      E2E_WORKSPACE_ORIGIN: 'http://127.0.0.1:4432',
      PUBLIC_API_ORIGIN: 'https://api.fixture.invalid',
    })).toEqual({
      site: 'http://127.0.0.1:4431', workspace: 'http://127.0.0.1:4432', api: 'https://api.fixture.invalid',
    });
    expect(() => testOrigins({ E2E_SITE_ORIGIN: 'https://example.com' })).toThrow('loopback');
    expect(() => testOrigins({ PUBLIC_API_ORIGIN: 'http://localhost:8787' })).toThrow('production HTTPS');
  });

  it('requires application CI to install Chromium and run the nonempty root browser suite', async () => {
    const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const document = parseDocument(workflow);
    expect(document.errors).toEqual([]);
    const steps = document.getIn(['jobs', 'application', 'steps']);
    if (!isSeq(steps)) throw new Error('Application CI must define executable job steps.');
    const commands = steps.items.filter(isMap).map((step) => step.get('run'))
      .filter((run): run is string => typeof run === 'string');
    expect.soft(commands.includes('npx playwright install --with-deps chromium'),
      'Application CI must install the bundled Chromium used by the root suite').toBe(true);
    expect.soft(commands.some((run) => /^\s*npm run test:e2e(?:\s|$)/m.test(run)),
      'Application CI must run production browser integration, not only unit tests').toBe(true);
    expect(commands.indexOf('npx playwright install --with-deps chromium')).toBeGreaterThan(commands.indexOf('npm ci'));
    expect(commands.indexOf('npm run test:e2e')).toBeGreaterThan(commands.indexOf('npx playwright install --with-deps chromium'));
    expect(commands.indexOf('npm run test:e2e')).toBeGreaterThan(commands.indexOf('npm run build'));
    expect(commands.indexOf('.\\infra\\scripts\\Test-StaticArtifacts.ps1 -ApiOrigin $env:PUBLIC_API_ORIGIN'))
      .toBeGreaterThan(commands.indexOf('npm run test:e2e'));
    expect(document.getIn(['jobs', 'application', 'env', 'PUBLIC_API_ORIGIN'])).toBe('https://api.domosdigial.com');
    expect(document.getIn(['jobs', 'application', 'env', 'ASTRO_TELEMETRY_DISABLED'])).toBe('1');
    expect(steps.items.filter(isMap).some((step) => step.getIn(['with', 'node-version']) === '24')).toBe(true);
    for (const step of steps.items.filter(isMap)) {
      expect(step.get('continue-on-error')).not.toBe(true);
      if (step.get('run') === 'npm run test:e2e') expect(step.has('if')).toBe(false);
    }
  });

  it('uses isolated production artifact servers and leaves deployment manual-only', async () => {
    expect(browserConfig.webServer).toEqual(expect.objectContaining({
      command: expect.stringContaining('npm run build --workspace=@domos/site && npm run build --workspace=@domos/workspace'),
      url: `${testOrigins().workspace}/__e2e/ready`,
      reuseExistingServer: false,
      env: { ASTRO_TELEMETRY_DISABLED: '1', PUBLIC_API_ORIGIN: testOrigins().api },
    }));
    expect(browserConfig.webServer).toEqual(expect.objectContaining({
      command: expect.stringContaining('serve-production.mjs'),
    }));
    const ci = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).not.toMatch(/azure\/login@|static-web-apps-deploy@|docker push/);
    const release = parseDocument(await readFile(new URL('../../../.github/workflows/deploy-manual.yml', import.meta.url), 'utf8'));
    expect(release.errors).toEqual([]);
    const triggers = release.get('on');
    if (!isMap(triggers)) throw new Error('Release workflow must declare its manual trigger.');
    expect(triggers.items.map((entry) => String(entry.key))).toEqual(['workflow_dispatch']);
  });
});
