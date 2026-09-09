import { describe, expect, it } from 'vitest';
import { buildOrigins, publicOrigin } from '../../scripts/origins.mjs';

describe('deployment origins', () => {
  it('preserves the future production defaults', () => {
    expect(buildOrigins({ NODE_ENV: 'production' })).toEqual({
      site: 'https://domosdigial.com',
      workspace: 'https://tools.domosdigial.com',
      api: 'https://api.domosdigial.com',
    });
  });
  it('uses the three exact generated preview origins', () => {
    expect(buildOrigins({
      NODE_ENV: 'production',
      PUBLIC_SITE_ORIGIN: 'https://site-example.azurestaticapps.net',
      PUBLIC_WORKSPACE_ORIGIN: 'https://tools-example.azurestaticapps.net',
      PUBLIC_API_ORIGIN: 'https://api.example.eastus2.azurecontainerapps.io',
    })).toEqual({
      site: 'https://site-example.azurestaticapps.net',
      workspace: 'https://tools-example.azurestaticapps.net',
      api: 'https://api.example.eastus2.azurecontainerapps.io',
    });
  });
  it('preserves development servers', () => {
    expect(buildOrigins({ NODE_ENV: 'development' })).toEqual({
      site: 'http://localhost:4321', workspace: 'http://localhost:4322', api: 'http://localhost:8787',
    });
  });
  it.each(['https://example.com/', 'https://user:secret@example.com', 'https://example.com/path', 'http://example.com', 'http://localhost:4321'])('rejects noncanonical production origin %s', (value) => {
    expect(() => publicOrigin(value)).toThrow();
  });
});
