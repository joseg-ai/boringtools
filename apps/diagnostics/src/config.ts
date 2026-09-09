import { z } from 'zod';
import { apiOriginSchema } from '@domos/contracts';

export const POLICY_VERSION = 'public-diagnostics-2026-09-08';
export const RESOLVER = 'Cloudflare DoH https://cloudflare-dns.com/dns-query (wire POST; 1.1.1.1)';

// All limits are per process/replica and multiply with replica count. No shared store.
// Untrusted platform proxies may aggregate callers under one source IP. XFF is ignored.
export const SERVICE_LIMITS = Object.freeze({
  concurrentRequests: 16,
  outboundConnections: 32,
  requestsPerMinute: 120,
  requestsPerIpMinute: 30,
  sourceEntries: 2048,
  dohBytes: 65_535,
  dnsRecords: 128,
});

export interface ServiceConfig {
  host: string;
  port: number;
  origins: string[];
  deniedHosts: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const production = env.NODE_ENV === 'production';
  const origin = apiOriginSchema.safeParse(env.PUBLIC_API_ORIGIN ?? 'https://api.domosdigial.com');
  const siteOrigin = apiOriginSchema.safeParse(env.PUBLIC_SITE_ORIGIN ?? 'https://domosdigial.com');
  const port = z.coerce.number().int().min(1).max(65_535).safeParse(env.PORT ?? '8787');
  const origins = (env.CORS_ORIGINS ?? (production
    ? 'https://tools.domosdigial.com' : 'http://localhost:4322')).split(',');
  const host = env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
  const validOrigins = origins.length > 0 && origins.length <= 16
    && new Set(origins).size === origins.length
    && origins.every((value) => apiOriginSchema.safeParse(value).success
      && (!production || value.startsWith('https://')));
  // There is deliberately no trusted-proxy or SSRF-bypass configuration.
  if (!origin.success || !siteOrigin.success || !port.success || !validOrigins
    || (env.NODE_ENV !== undefined && !['development', 'test', 'production'].includes(env.NODE_ENV))
    || !['0.0.0.0', '127.0.0.1', '::'].includes(host)
    || Boolean(env.NODE_DEBUG?.trim()) || Boolean(env.NODE_DEBUG_NATIVE?.trim())
    || (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== 'false')
    || (production && (!origin.data.startsWith('https://') || !siteOrigin.data.startsWith('https://')))) {
    throw new Error('Invalid diagnostics service configuration.');
  }
  const platformHost = env.CONTAINER_APP_HOSTNAME;
  if (platformHost !== undefined && !/^[a-z0-9.-]{1,253}$/.test(platformHost)) {
    throw new Error('Invalid diagnostics service configuration.');
  }
  return {
    host, port: port.data, origins,
    deniedHosts: [
      'domosdigial.com', new URL(origin.data).hostname, new URL(siteOrigin.data).hostname,
      ...origins.map((value) => new URL(value).hostname),
      ...(platformHost ? [platformHost] : []),
    ],
  };
}
