export function publicOrigin(value, allowLocal = false) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value !== url.origin || (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:'))) {
    throw new Error('Public origins must be exact HTTPS origins; HTTP is development-loopback only.');
  }
  return value;
}

export function buildOrigins(env) {
  const local = env.NODE_ENV !== 'production';
  return {
    site: publicOrigin(env.PUBLIC_SITE_ORIGIN ?? (local ? 'http://localhost:4321' : 'https://domosdigial.com'), local),
    workspace: publicOrigin(env.PUBLIC_WORKSPACE_ORIGIN ?? (local ? 'http://localhost:4322' : 'https://tools.domosdigial.com'), local),
    api: publicOrigin(env.PUBLIC_API_ORIGIN ?? (local ? 'http://localhost:8787' : 'https://api.domosdigial.com'), local),
  };
}
