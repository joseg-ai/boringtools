import { LIMITS, type HttpReport, type ResolvedApiRequest } from '@domos/contracts';
import { DnsResolver } from './dns.js';
import { DiagnosticError, checkAbort, safeError, type Observation } from './errors.js';
import { RequestBudget } from './limits.js';
import type { PinnedTransport } from './network.js';
import { httpTarget, publicAddress, redirectTarget, sameAddress } from './public-policy.js';

export async function inspectHttp(
  request: ResolvedApiRequest<'http'>, resolver: DnsResolver, transport: PinnedTransport,
  budget: RequestBudget, deniedHosts: readonly string[],
): Promise<Observation<HttpReport>> {
  let target = httpTarget(request.url, deniedHosts);
  const data: HttpReport = {
    requestedUrl: target.url.href, method: request.method, hops: [], termination: 'complete',
  };
  const seen = new Set<string>();
  try {
    while (true) {
      checkAbort(budget.signal, 'connect');
      if (seen.has(target.url.href)) {
        data.termination = 'redirect-loop';
        throw new DiagnosticError('TARGET_BLOCKED', 'policy');
      }
      seen.add(target.url.href);
      const addresses = target.literal ? [target.literal] : await resolver.addresses(target.hostname, budget, deniedHosts);
      for (const address of addresses) publicAddress(address);
      const address = addresses[0];
      if (!address) throw new DiagnosticError('UPSTREAM_ERROR', 'dns');
      const start = performance.now();
      const result = await transport(target, address, request.method, budget.signal);
      checkAbort(budget.signal, 'headers');
      if (!sameAddress(result.remoteAddress, address)) throw new DiagnosticError('TARGET_BLOCKED', 'connect');
      const locations = result.headers.filter((header) => header.name.toLowerCase() === 'location');
      if (locations.length > 1) throw new DiagnosticError('UPSTREAM_ERROR', 'headers');
      const location = locations[0]?.value ?? null;
      if (location !== null && Buffer.byteLength(location) > 2048) {
        throw new DiagnosticError('LIMIT_EXCEEDED', 'headers');
      }
      data.hops.push({
        ...result, url: target.url.href, method: request.method,
        durationMs: Math.max(0, performance.now() - start), location,
      });
      if (![301, 302, 303, 307, 308].includes(result.statusCode) || location === null) return { data };
      if (data.hops.length >= LIMITS.httpHops) {
        data.termination = 'redirect-limit';
        throw new DiagnosticError('LIMIT_EXCEEDED', 'headers');
      }
      target = redirectTarget(location, target, deniedHosts);
    }
  } catch (error) {
    if (!data.hops.length) throw error;
    const detail = safeError(error, 'connect', budget.signal);
    if (data.termination === 'complete') {
      data.termination = detail.code === 'TIMEOUT' ? 'timeout'
        : detail.code === 'TARGET_BLOCKED' ? 'blocked'
          : detail.code === 'LIMIT_EXCEEDED' ? 'limit-exceeded' : 'upstream-error';
    }
    return { data, error: detail };
  }
}
