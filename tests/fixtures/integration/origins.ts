import { PUBLIC_ORIGINS } from '@domos/catalog';

export function testOrigins(env: NodeJS.ProcessEnv = process.env) {
  function local(value: string) {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('E2E frontends must use exact loopback HTTP origins.');
    }
    return url.origin;
  }
  const api = env.PUBLIC_API_ORIGIN ?? PUBLIC_ORIGINS.api;
  if (new URL(api).origin !== api || !api.startsWith('https://')) throw new Error('E2E requires a production HTTPS API origin (intercepted, never contacted).');
  return {
    site: local(env.E2E_SITE_ORIGIN ?? 'http://localhost:4321'),
    workspace: local(env.E2E_WORKSPACE_ORIGIN ?? 'http://localhost:4322'),
    api,
  };
}

export const origins = testOrigins();
