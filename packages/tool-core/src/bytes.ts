import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { invalid } from './errors.js';

export { bytesToHex };

export function ensureUnicode(text: string): void {
  if (/[\uD800-\uDFFF]/u.test(text)) invalid('Text contains an unpaired Unicode surrogate.');
}

export function readBytes(text: string, encoding: 'utf8' | 'hex'): Uint8Array {
  if (encoding === 'hex') {
    if (!/^(?:[a-fA-F0-9]{2})*$/.test(text)) invalid('Hex input must contain complete byte pairs without separators.');
    return hexToBytes(text);
  }
  ensureUnicode(text);
  return new TextEncoder().encode(text);
}

export function encodeBase64(bytes: Uint8Array, urlSafe = false, padding = true): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  let text = btoa(binary);
  if (urlSafe) text = text.replace(/\+/g, '-').replace(/\//g, '_');
  return padding ? text : text.replace(/=+$/, '');
}

export function decodeBase64(text: string, urlSafe = false, unpaddedOnly = false): Uint8Array {
  const alphabet = urlSafe ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!alphabet.test(text) || (unpaddedOnly && text.includes('='))) {
    invalid('Invalid Base64 alphabet or padding.');
  }
  const raw = text.replace(/=+$/, '');
  const needed = (4 - raw.length % 4) % 4;
  if (raw.length % 4 === 1 || (text.includes('=') && (text.length % 4 !== 0 || text.length - raw.length !== needed))) {
    invalid('Invalid Base64 length or padding.');
  }
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(needed);
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (encodeBase64(bytes, urlSafe, false) !== raw) invalid('Base64 has nonzero unused bits (noncanonical encoding).');
  return bytes;
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) invalid('Bytes are not valid UTF-8.');
    throw error;
  }
}
