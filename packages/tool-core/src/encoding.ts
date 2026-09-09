import { LosslessNumber } from 'lossless-json';
import { instantSchema, type LocalToolHandler, type LocalToolOutput } from '@domos/contracts';
import { bytesToHex, decodeBase64, decodeUtf8, encodeBase64, ensureUnicode, readBytes } from './bytes.js';
import { invalid, isRecord, limit } from './errors.js';
import { parseJson, stringifyJson } from './structured.js';

export const base64: LocalToolHandler<'base64'> = async (input) => {
  const bytes = input.operation === 'encode'
    ? readBytes(input.text, input.byteFormat) : decodeBase64(input.text, input.alphabet === 'url-safe');
  const text = input.operation === 'encode'
    ? encodeBase64(bytes, input.alphabet === 'url-safe', input.padding)
    : input.byteFormat === 'hex' ? bytesToHex(bytes) : decodeUtf8(bytes);
  return {
    kind: 'result', notices: [], data: {
      text, byteLength: bytes.length, format: input.operation === 'encode' ? 'base64' : input.byteFormat,
    },
  };
};

function decodeComponent(text: string, form: boolean): string {
  ensureUnicode(text);
  try {
    return decodeURIComponent(form ? text.replace(/\+/g, ' ') : text);
  } catch (error) {
    if (error instanceof URIError) invalid('Invalid percent escape or UTF-8 sequence.');
    throw error;
  }
}

function parseUrl(text: string): URL {
  ensureUnicode(text);
  // WHATWG URL otherwise accepts malformed percent escapes and replaces bad
  // query UTF-8. Reject those instead of silently presenting repaired input.
  decodeComponent(text, false);
  try {
    return new URL(text);
  } catch (error) {
    if (error instanceof TypeError) invalid('Enter a valid absolute URL, including its scheme.');
    throw error;
  }
}

export const url: LocalToolHandler<'url-workbench'> = async (input) => {
  if (input.action === 'encode' || input.action === 'decode') {
    ensureUnicode(input.text);
    const text = input.action === 'decode' ? decodeComponent(input.text, input.mode === 'form')
      : input.mode === 'form' ? new URLSearchParams([['', input.text]]).toString().slice(1)
        : encodeURIComponent(input.text);
    return { kind: 'result', notices: [], data: { text, components: null } };
  }
  const parsed = parseUrl(input.action === 'parse' ? input.url : input.baseUrl);
  if (input.action === 'build') {
    if (input.replaceQuery) parsed.search = '';
    for (const pair of input.parameters) {
      ensureUnicode(pair.name);
      ensureUnicode(pair.value);
      parsed.searchParams.append(pair.name, pair.value);
    }
  }
  const parameters = [...parsed.searchParams].map(([name, value]) => ({ name, value }));
  if (parameters.length > 1000) limit('URL exceeds the 1,000-query-parameter limit.');
  if (parameters.some(({ name, value }) =>
    new TextEncoder().encode(name).length > 8192 || new TextEncoder().encode(value).length > 8192)) {
    limit('URL query names and values must not exceed 8,192 bytes each.');
  }
  return {
    kind: 'result', notices: [], data: {
      text: parsed.href,
      components: {
        protocol: parsed.protocol, username: parsed.username, password: parsed.password,
        hostname: parsed.hostname, port: parsed.port, pathname: parsed.pathname,
        search: parsed.search, hash: parsed.hash, origin: parsed.origin, parameters,
      },
    },
  };
};

export const jwt: LocalToolHandler<'jwt-decoder'> = async (input) => {
  const segments = input.token.split('.');
  if (segments.length !== 3) invalid('A JWS token must have exactly three dot-separated segments; JWE is not supported.');
  const [head, body, signature] = segments;
  if (!head || !body || signature === undefined) invalid('JWS header and payload cannot be empty.');
  const headerText = decodeUtf8(decodeBase64(head, true, true));
  const payloadText = decodeUtf8(decodeBase64(body, true, true));
  decodeBase64(signature, true, true);
  const header = parseJson(headerText);
  const payload = parseJson(payloadText);
  if (!isRecord(header) || header instanceof LosslessNumber || !isRecord(payload) || payload instanceof LosslessNumber) {
    invalid('JWT header and claims payload must be JSON objects.');
  }
  if (typeof header.alg !== 'string' || !header.alg) invalid('JWS header requires a string alg member.');
  if (header.b64 === false) invalid('Unencoded JWS payloads are not supported.');
  if ((header.alg === 'none') !== (signature === '')) invalid('Only an unsecured alg=none token may have an empty signature.');
  const claims: LocalToolOutput<'jwt-decoder'>['claims'] = [];
  for (const name of ['exp', 'nbf', 'iat'] as const) {
    if (!Object.hasOwn(payload, name)) continue;
    const value = payload[name];
    const rawValue = stringifyJson(value);
    if (new TextEncoder().encode(rawValue).length > 4096) limit('JWT timestamp claim exceeds the 4,096-byte limit.');
    let isoTime: string | null = null;
    let status: 'past' | 'future' | 'not-a-timestamp' = 'not-a-timestamp';
    if (value instanceof LosslessNumber) {
      const seconds = Number(value.value);
      const milliseconds = seconds * 1000;
      if (Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15) {
        const iso = new Date(milliseconds).toISOString();
        if (instantSchema.safeParse(iso).success) {
          isoTime = iso;
          status = milliseconds <= Date.parse(input.referenceTime) ? 'past' : 'future';
        }
      }
    }
    claims.push({ name, rawValue, isoTime, status });
  }
  return {
    kind: 'result', notices: [{
      level: 'warning', code: 'UNVERIFIED_JWT',
      text: 'Decoded only. Signature, issuer, audience, and claims are unverified; never use this output to authorize access.',
    }], data: { headerText, payloadText, signature, verification: 'unverified', claims },
  };
};
