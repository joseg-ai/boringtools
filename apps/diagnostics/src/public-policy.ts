import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { dnsNameSchema, domainSchema } from '@domos/contracts';
import { DiagnosticError } from './errors.js';

const privateSuffixes = [
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home',
  'corp', 'private', 'test', 'invalid', 'example', 'onion', 'alt', 'arpa',
];
const extraV4 = ['168.63.129.16/32', '192.0.0.0/24', '192.88.99.0/24'];
const extraV6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'];
const v4Networks = extraV4.map((cidr) => ipaddr.IPv4.parseCIDR(cidr));
const v6Networks = extraV6.map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

function blocked(): never {
  throw new DiagnosticError('TARGET_BLOCKED', 'policy');
}

export function publicAddress(value: string, canonical = false): string {
  const family = isIP(value);
  if (!family || value.includes('%')) return blocked();
  const address = ipaddr.parse(value);
  const normalized = address instanceof ipaddr.IPv6 ? address.toRFC5952String() : address.toString();
  if (canonical && value !== normalized) return blocked();
  if (address.range() !== 'unicast') return blocked();
  if (address instanceof ipaddr.IPv4) {
    if (v4Networks.some((range) => address.match(range))) return blocked();
  } else {
    // Permit allocated global unicast only; range() alone calls many reserved
    // IPv6 networks "unicast". Exclude special-purpose and transition allocations.
    if (!address.match(ipaddr.IPv6.parseCIDR('2000::/3'))
      || v6Networks.some((range) => address.match(range))) return blocked();
    const bytes = address.toByteArray();
    // ISATAP embeds IPv4 in a global prefix.
    if ((bytes[8] === 0 || bytes[8] === 2) && bytes[9] === 0
      && bytes[10] === 0x5e && bytes[11] === 0xfe) return blocked();
  }
  return normalized;
}

export function sameAddress(left: string, right: string): boolean {
  if (!isIP(left) || !isIP(right)) return false;
  // Do not process() mapped IPv6: those addresses are explicitly disallowed.
  try { return publicAddress(left) === publicAddress(right); } catch (error) {
    if (error instanceof DiagnosticError) return false;
    throw error;
  }
}

export function publicName(value: string, serviceLabels = true): string {
  const name = value.toLowerCase().replace(/\.$/, '');
  const schema = serviceLabels ? dnsNameSchema : domainSchema;
  if (!schema.safeParse(name).success || !name.includes('.') || isIP(name)
    || name.split('.').every((part) => /^\d+$/.test(part))
    || privateSuffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))
    || !/^[a-z][a-z0-9-]*$/.test(name.split('.').at(-1) ?? '')) return blocked();
  return name;
}

export function reverseName(value: string): string {
  const address = publicAddress(value, true);
  if (isIP(address) === 4) return `${address.split('.').reverse().join('.')}.in-addr.arpa`;
  return `${ipaddr.parse(address).toByteArray()
    .map((byte) => byte.toString(16).padStart(2, '0')).join('').split('').reverse().join('.')}.ip6.arpa`;
}

export function queryName(value: string, onlyPtr: boolean): string {
  const name = value.toLowerCase().replace(/\.$/, '');
  if (isIP(name)) {
    if (!onlyPtr) return blocked();
    return reverseName(name);
  }
  if (name.endsWith('.in-addr.arpa')) {
    const labels = name.slice(0, -13).split('.');
    if (!onlyPtr || labels.length !== 4) return blocked();
    const address = labels.reverse().join('.');
    if (reverseName(address) !== name) return blocked();
    return name;
  }
  if (name.endsWith('.ip6.arpa')) {
    const labels = name.slice(0, -9).split('.');
    if (!onlyPtr || labels.length !== 32 || labels.some((label) => !/^[0-9a-f]$/.test(label))) return blocked();
    const hex = labels.reverse().join('');
    const address = ipaddr.IPv6.parse(hex.match(/.{4}/g)!.join(':')).toRFC5952String();
    if (reverseName(address) !== name) return blocked();
    return name;
  }
  return publicName(name);
}

export interface Target {
  url: URL;
  hostname: string;
  literal: string | null;
}

export function httpTarget(value: string, deniedHosts: readonly string[]): Target {
  if (Buffer.byteLength(value) > 2048 || /[\u0000-\u0020\u007f-\u009f\\]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) return blocked();
  const match = /^(https?):\/\/([^/?#]+)(?:[/?#]|$)/.exec(value);
  if (!match) return blocked();
  const authority = match[2]!;
  if (/[@%]/.test(authority) || /[^\x21-\x7e]/.test(authority)) return blocked();
  const parts = /^(\[[0-9a-f:]+\]|[a-zA-Z0-9.-]+)(?::(80|443))?$/.exec(authority);
  if (!parts) return blocked();
  const rawHost = parts[1]!;
  const port = parts[2];
  if (port && port !== (match[1] === 'https' ? '443' : '80')) return blocked();
  const hostname = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost.toLowerCase();
  let url: URL;
  try { url = new URL(value); } catch { return blocked(); }
  if (url.username || url.password || url.hostname.toLowerCase() !== rawHost.toLowerCase()
    || hostname.endsWith('.')) return blocked();
  const literal = isIP(hostname) ? publicAddress(hostname, true) : null;
  if (!literal) publicName(hostname, false);
  if (deniedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return blocked();
  url.hash = '';
  return { url, hostname, literal };
}

export function redirectTarget(location: string, current: Target, deniedHosts: readonly string[]): Target {
  if (Buffer.byteLength(location) > 2048 || /[\u0000-\u0020\u007f-\u009f\\]/u.test(location)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(location)) return blocked();
  // Validate raw absolute/network-path authorities before WHATWG normalization.
  let next: Target;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(location)) next = httpTarget(location, deniedHosts);
  else if (location.startsWith('//')) next = httpTarget(`${current.url.protocol}${location}`, deniedHosts);
  else next = httpTarget(new URL(location, current.url).href, deniedHosts);
  if (current.url.protocol === 'https:' && next.url.protocol !== 'https:') return blocked();
  return next;
}
