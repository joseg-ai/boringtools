import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  LIMITS, PASSWORD_ALPHABETS, localResultSchemas, localOutputSchemas,
  type LocalToolId, type LocalToolInput, type LocalToolOutput, type SubnetState,
} from '@domos/contracts';
import { executeLocalTool, hashFile } from './index.js';
import { readBytes, encodeBase64 } from './bytes.js';
import { validated } from './runtime.js';
import { localInputSchemas } from '@domos/contracts';

async function data<K extends LocalToolId>(
  id: K, input: LocalToolInput<K>,
): Promise<LocalToolOutput<K>> {
  const result = await executeLocalTool(id, input);
  expect(localResultSchemas[id].safeParse(result).success).toBe(true);
  if (result.kind !== 'result') throw new Error(JSON.stringify(result.error));
  const parseOutput: { [P in LocalToolId]: (value: unknown) => LocalToolOutput<P> } = {
    'ipv4-subnet-planner': localOutputSchemas['ipv4-subnet-planner'].parse,
    'email-header-analyzer': localOutputSchemas['email-header-analyzer'].parse,
    chmod: localOutputSchemas.chmod.parse,
    'password-generator': localOutputSchemas['password-generator'].parse,
    'json-yaml-workbench': localOutputSchemas['json-yaml-workbench'].parse,
    base64: localOutputSchemas.base64.parse,
    'url-workbench': localOutputSchemas['url-workbench'].parse,
    'jwt-decoder': localOutputSchemas['jwt-decoder'].parse,
    'sha-checksums': localOutputSchemas['sha-checksums'].parse,
    'regex-tester': localOutputSchemas['regex-tester'].parse,
    'text-diff': localOutputSchemas['text-diff'].parse,
    'cron-helper': localOutputSchemas['cron-helper'].parse,
    'epoch-time': localOutputSchemas['epoch-time'].parse,
  };
  return parseOutput[id](result.data);
}

async function error<K extends LocalToolId>(
  id: K, input: LocalToolInput<K>, code = 'INVALID_INPUT',
) {
  const result = await executeLocalTool(id, input);
  expect(result).toMatchObject({ kind: 'error', error: { code } });
}

describe('IPv4 subnet planner', () => {
  it('uses unsigned arithmetic across /0 and the high address boundary', async () => {
    const all = await data('ipv4-subnet-planner', { action: 'create', cidr: '255.255.255.255/0' });
    expect(all.rows[0]).toMatchObject({
      cidr: '0.0.0.0/0', network: '0.0.0.0', broadcast: '255.255.255.255',
      totalAddresses: '4294967296', usableHosts: '4294967294',
      firstUsable: '0.0.0.1', lastUsable: '255.255.255.254',
    });
    const split = await data('ipv4-subnet-planner', { action: 'split', state: all.state, cidr: '0.0.0.0/0' });
    expect(split.state.allocations.map((a) => a.cidr)).toEqual(['0.0.0.0/1', '128.0.0.0/1']);
    const joined = await data('ipv4-subnet-planner', {
      action: 'join', state: split.state, cidrs: ['128.0.0.0/1', '0.0.0.0/1'],
    });
    expect(joined.state).toEqual(all.state);
  });

  it('handles /31 point-to-point and /32 host semantics', async () => {
    const point = await data('ipv4-subnet-planner', { action: 'create', cidr: '255.255.255.254/31' });
    expect(point.rows[0]).toMatchObject({ broadcast: null, firstUsable: '255.255.255.254', lastUsable: '255.255.255.255', usableHosts: '2', semantics: 'point-to-point' });
    const hosts = await data('ipv4-subnet-planner', { action: 'split', state: point.state, cidr: point.state.rootCidr });
    expect(hosts.rows[1]).toMatchObject({ cidr: '255.255.255.255/32', broadcast: null, usableHosts: '1', semantics: 'host' });
    await error('ipv4-subnet-planner', { action: 'split', state: hosts.state, cidr: '255.255.255.255/32' });
  });

  it('requires explicit conflict resolution and preserves imported/exported annotations', async () => {
    const initial = await data('ipv4-subnet-planner', { action: 'create', cidr: '10.0.0.0/24', annotation: { note: 'start', color: 'rose' } });
    const split = await data('ipv4-subnet-planner', { action: 'split', state: initial.state, cidr: initial.state.rootCidr });
    const changed = await data('ipv4-subnet-planner', { action: 'annotate', state: split.state, cidr: '10.0.0.0/25', annotation: { note: '=cmd,"quoted"\nline', color: 'blue' } });
    await error('ipv4-subnet-planner', { action: 'join', state: changed.state, cidrs: ['10.0.0.0/25', '10.0.0.128/25'] });
    const joined = await data('ipv4-subnet-planner', { action: 'join', state: changed.state, cidrs: ['10.0.0.0/25', '10.0.0.128/25'], annotation: { note: 'chosen', color: 'amber' } });
    expect(joined.rows[0]?.note).toBe('chosen');
    const csv = await data('ipv4-subnet-planner', { action: 'export', state: changed.state, format: 'csv' });
    expect(csv.download?.text).toContain(`"'=cmd,""quoted""\nline"`);
    const exported = await data('ipv4-subnet-planner', { action: 'export', state: changed.state, format: 'json' });
    const imported = await data('ipv4-subnet-planner', { action: 'import', json: exported.download!.text });
    expect(imported.state).toEqual(changed.state);
  });

  it('rejects invalid partitions on every state-consuming operation', async () => {
    const valid = await data('ipv4-subnet-planner', { action: 'create', cidr: '10.0.0.0/24' });
    const bad: SubnetState[] = [
      { ...valid.state, rootCidr: '10.0.0.1/24' },
      { ...valid.state, allocations: [{ cidr: '10.0.0.0/25', note: '', color: 'teal' }] },
      { ...valid.state, allocations: [{ cidr: '10.0.0.1/24', note: '', color: 'teal' }] },
      { ...valid.state, allocations: [{ cidr: '10.0.1.0/24', note: '', color: 'teal' }] },
      { ...valid.state, allocations: [...valid.state.allocations, ...valid.state.allocations] },
    ];
    for (const state of bad) {
      await error('ipv4-subnet-planner', { action: 'export', state, format: 'json' });
      await error('ipv4-subnet-planner', { action: 'import', json: JSON.stringify(state) });
      await error('ipv4-subnet-planner', { action: 'annotate', state, cidr: '10.0.0.0/24', annotation: {} });
    }
    await error('ipv4-subnet-planner', { action: 'import', json: '{"version":1,"version":1}' });
    await error('ipv4-subnet-planner', { action: 'import', json: JSON.stringify(valid.state).replace('"version":1', '"version":1.0000000000000000000001') });
  });

  it('rejects non-sibling joins and enforces allocation cap', async () => {
    const state: SubnetState = {
      version: 1, rootCidr: '10.0.0.0/22',
      allocations: [0, 1, 2, 3].map((value) => ({ cidr: `10.0.${value}.0/24`, note: '', color: 'teal' })),
    };
    await error('ipv4-subnet-planner', { action: 'join', state, cidrs: ['10.0.1.0/24', '10.0.2.0/24'] });
    const capped: SubnetState = {
      version: 1, rootCidr: '0.0.0.0/0',
      allocations: Array.from({ length: 4096 }, (_, i) => ({
        cidr: `${Math.floor(i / 16)}.${(i % 16) * 16}.0.0/12`, note: '', color: 'slate',
      })),
    };
    await error('ipv4-subnet-planner', { action: 'split', state: capped, cidr: '0.0.0.0/12' }, 'LIMIT_EXCEEDED');
  });
});

describe('chmod', () => {
  it.each([
    ['0755', 'rwxr-xr-x'], ['4755', 'rwsr-xr-x'], ['2640', 'rw-r-S---'],
    ['1700', 'rwx-----T'], ['7777', 'rwsrwsrwt'], ['000', '---------'],
  ])('renders %s including special bits', async (value, symbolic) => {
    expect((await data('chmod', { operation: 'from-octal', value })).symbolic).toBe(symbolic);
  });
  it('supports all input modes and explicit symbolic operations', async () => {
    expect((await data('chmod', { operation: 'from-bits', owner: 7, group: 5, other: 0, setgid: true })).octal).toBe('2750');
    expect((await data('chmod', { operation: 'apply-symbolic', base: '0777', expression: 'u=rw,g-w,o=,u+s' })).octal).toBe('4650');
    expect((await data('chmod', { operation: 'apply-symbolic', base: '7777', expression: 'a=' })).octal).toBe('0000');
    await error('chmod', { operation: 'apply-symbolic', base: '0644', expression: 'a+X' });
    await error('chmod', { operation: 'from-octal', value: '888' });
  });
});

describe('cryptographic passwords and passphrases', () => {
  it('uses the selected disjoint classes and reports exact constrained entropy', async () => {
    const result = await data('password-generator', { mode: 'password', length: 4, count: 20 });
    for (const password of result.values) {
      expect(password).toHaveLength(4);
      for (const key of ['uppercase', 'lowercase', 'digits', 'symbols'] as const) {
        expect([...password].some((char) => PASSWORD_ALPHABETS[key].includes(char))).toBe(true);
      }
    }
    expect(result.entropyBits).toBeCloseTo(Math.log2(24 * 26 * 26 * 10 * PASSWORD_ALPHABETS.symbols.length), 10);
    expect(result.entropyLabel).toBe('exact');
    const digits = await data('password-generator', {
      mode: 'password', length: 256, uppercase: false, lowercase: false, symbols: false,
      excludeAmbiguous: true, requireEachClass: false,
    });
    expect(digits.values[0]).toMatch(/^[2-9]{256}$/);
    expect(digits.entropyBits).toBe(768);
  });
  it('uses rejection sampling rather than biased modulo mapping', async () => {
    let calls = 0;
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      if (!(array instanceof Uint32Array)) throw new Error('Unexpected random buffer');
      array[0] = calls++ === 0 ? 0xffffffff : 0;
      return array;
    });
    const result = await data('password-generator', { mode: 'password', length: 4, uppercase: false, lowercase: false, symbols: false });
    expect(result.values).toEqual(['0000']);
    expect(calls).toBe(5);
    spy.mockRestore();
  });
  it('samples the installed English list and does not claim wallet seeds', async () => {
    const phrase = await data('password-generator', { mode: 'passphrase', count: 2, words: 6, capitalize: true });
    expect(phrase.values[0]).toMatch(/^(?:[A-Z][a-z]+-){5}[A-Z][a-z]+$/);
    expect(phrase).toMatchObject({ entropyBits: 66, entropyLabel: 'exact', alphabetSize: 2048, wordlist: 'scure-bip39/english', randomness: 'cryptographic' });
    expect((await data('password-generator', { mode: 'passphrase', separator: '' })).entropyLabel).toBe('lower-bound');
    await error('password-generator', { mode: 'password', uppercase: false, lowercase: false, digits: false, symbols: false });
  });
});

describe('lossless JSON and bounded YAML', () => {
  it('preserves unsafe integers and decimal lexemes through format and minify', async () => {
    const text = '{"n":9007199254740993123456789,"d":1.234567890123456789,"z":-0,"e":1e999}';
    const formatted = await data('json-yaml-workbench', { text, source: 'json', action: 'format', indent: 4 });
    expect(formatted.text).toContain('9007199254740993123456789');
    expect(formatted.text).toContain('1.234567890123456789');
    expect((await data('json-yaml-workbench', { text: formatted.text!, source: 'json', action: 'minify' })).text).toBe(text);
    expect((await data('json-yaml-workbench', { text, source: 'json', action: 'validate' })).text).toBeNull();
  });
  it('rejects duplicate JSON keys even when their values agree or keys are escaped', async () => {
    for (const text of ['{"a":1,"a":1}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '{"x":"\\ud800"}', '{"x":}']) {
      await error('json-yaml-workbench', { text, source: 'json', action: 'format' });
    }
  });
  it('does not confuse ordinary objects or strings with lossless numeric sentinels', async () => {
    const text = '{"isLosslessNumber":true,"value":"not numeric","toString":5,"n":9007199254740993123,"s":"\\u0000domos-number-0","escaped":"\\\\\\"\\\\u0000domos-number-1\\\\\\""}';
    expect((await data('json-yaml-workbench', { text, source: 'json', action: 'minify' })).text).toBe(text);
  });
  it('preserves prototype-named JSON keys as data, including primitive and escaped keys', async () => {
    for (const text of [
      '{"__proto__":{"x":1}}', '{"__proto__":null}', '{"__proto__":42}',
      '{"constructor":1,"toString":2,"hasOwnProperty":3}',
      '{"\\u0000domos-prototype-0":1,"nested":{"__proto__":"text"}}',
      '{"__\\u0070roto__":false}',
    ]) {
      const output = await data('json-yaml-workbench', { text, source: 'json', action: 'minify' });
      expect(JSON.parse(output.text!)).toEqual(JSON.parse(text));
    }
    await error('json-yaml-workbench', { text: '{"__proto__":1,"__proto__":1}', source: 'json', action: 'validate' });
  });
  it('converts big integers without rounding and rejects unsupported numeric conversion', async () => {
    const converted = await data('json-yaml-workbench', { text: '{"n":9007199254740993123456789}', source: 'json', action: 'convert', target: 'yaml' });
    const back = await data('json-yaml-workbench', { text: converted.text!, source: 'yaml', action: 'convert', target: 'json' });
    expect(back.text).toContain('9007199254740993123456789');
    await error('json-yaml-workbench', { text: '{"d":1.234567890123456789}', source: 'json', action: 'convert', target: 'yaml' }, 'UNSUPPORTED');
    await error('json-yaml-workbench', { text: 'd: 1.234567890123456789', source: 'yaml', action: 'format' }, 'UNSUPPORTED');
    const decimals = await data('json-yaml-workbench', { text: 'a: .5\nb: -.5\nc: 0001.2\nd: +1.2\ne: 1.e3\nf: -0', source: 'yaml', action: 'convert', target: 'json' });
    expect(decimals.text).toContain('"f": -0');
    expect(JSON.parse(decimals.text!)).toEqual({ a: 0.5, b: -0.5, c: 1.2, d: 1.2, e: 1000, f: -0 });
    expect((await data('json-yaml-workbench', { text: 'x: -0', source: 'yaml', action: 'format' })).text).toContain('-0');
  });
  it('preserves YAML comments on format and removes them only for JSON conversion', async () => {
    const text = '# before\nvalue: 2 # inline\narray:\n  - true\n  - null\n';
    const result = await data('json-yaml-workbench', { text, source: 'yaml', action: 'format' });
    expect(result.text).toContain('# before');
    expect(result.text).toContain('# inline');
    expect(result.comments).toBe('preserved');
    const json = await data('json-yaml-workbench', { text, source: 'yaml', action: 'convert', target: 'json' });
    expect(JSON.parse(json.text!)).toEqual({ value: 2, array: [true, null] });
    expect(json.comments).toBe('removed');
  });
  it('rejects YAML duplicate keys, custom tags, unsupported data, cycles and expansion bombs', async () => {
    await error('json-yaml-workbench', { text: 'x: 1\nx: 2', source: 'yaml', action: 'format' });
    for (const text of ['x: !execute hi', 'x: .inf', '? [a,b]\n: 1', 'x: !!timestamp 2020-01-01', 'x: .nan', 'a: &a {x: 1}\nb: {<<: *a}', '%YAML 1.1\n---\nx: yes']) {
      await error('json-yaml-workbench', { text, source: 'yaml', action: 'convert', target: 'json' }, 'UNSUPPORTED');
    }
    await error('json-yaml-workbench', { text: 'a: &a [*a]', source: 'yaml', action: 'format' });
    await error('json-yaml-workbench', { text: 'a: &a 1\nb: [' + Array(51).fill('*a').join(',') + ']', source: 'yaml', action: 'format' }, 'LIMIT_EXCEEDED');
    expect((await data('json-yaml-workbench', { text: 'a: &a [1,2]\nb: *a', source: 'yaml', action: 'convert', target: 'json' })).text).toContain('"b"');
  });
  it('enforces depth, nodes and UTF-8 byte budgets before expensive work', async () => {
    for (const source of ['json', 'yaml'] as const) {
      await error('json-yaml-workbench', { text: '['.repeat(2000) + '0' + ']'.repeat(2000), source, action: 'format' }, 'LIMIT_EXCEEDED');
      await error('json-yaml-workbench', { text: '[' + '0,'.repeat(50_000) + '0]', source, action: 'format' }, 'LIMIT_EXCEEDED');
    }
    await error('json-yaml-workbench', { text: Array.from({ length: 66 }, (_, i) => ' '.repeat(i) + 'a:').join('\n'), source: 'yaml', action: 'format' }, 'LIMIT_EXCEEDED');
    await error('json-yaml-workbench', { text: '"' + '😀'.repeat(LIMITS.textBytes / 4) + '"', source: 'json', action: 'format' }, 'LIMIT_EXCEEDED');
  });
  it('bounds a large flat mapping without quadratic duplicate comparisons', async () => {
    const text = Array.from({ length: 20_000 }, (_, i) => `field${i}: ${i}`).join('\n');
    const result = await data('json-yaml-workbench', { text, source: 'yaml', action: 'validate' });
    expect(result.valid).toBe(true);
    await error('json-yaml-workbench', { text: `${text}\nfield0: 0`, source: 'yaml', action: 'validate' });
  });
});

describe('Base64 and URL encoding', () => {
  it('round-trips arbitrary UTF-8 and binary in either alphabet', async () => {
    for (const alphabet of ['standard', 'url-safe'] as const) {
      const encoded = await data('base64', { operation: 'encode', text: 'café 😀\uFEFF', alphabet, padding: false });
      expect((await data('base64', { operation: 'decode', text: encoded.text, alphabet })).text).toBe('café 😀\uFEFF');
      const binary = await data('base64', { operation: 'encode', text: 'ffff00', byteFormat: 'hex', alphabet });
      expect((await data('base64', { operation: 'decode', text: binary.text, byteFormat: 'hex', alphabet })).text).toBe('ffff00');
    }
    expect((await data('base64', { operation: 'encode', text: '' })).text).toBe('');
    expect((await data('base64', { operation: 'decode', text: 'Zg==' })).text).toBe('f');
  });
  it.each(['A', 'Zg=', 'Zg===', 'Zh==', 'Zm9=', 'Z=g=', 'Z g==', '__==', '===='])('rejects malformed Base64 %s', async (text) => {
    await error('base64', { operation: 'decode', text });
  });
  it('rejects malformed Unicode and partial hex bytes', async () => {
    await error('base64', { operation: 'decode', text: '/w==' });
    await error('base64', { operation: 'encode', text: 'f', byteFormat: 'hex' });
    await error('base64', { operation: 'encode', text: '\ud800' });
  });
  it('preserves duplicate query parameters and distinguishes form from component plus', async () => {
    const parsed = await data('url-workbench', { action: 'parse', url: 'https://user:pass@example.com:8443/p?a=1&a=two+words#x' });
    expect(parsed.components).toMatchObject({ hostname: 'example.com', port: '8443', parameters: [{ name: 'a', value: '1' }, { name: 'a', value: 'two words' }] });
    const built = await data('url-workbench', { action: 'build', baseUrl: parsed.text, replaceQuery: false, parameters: [{ name: 'a', value: '+' }] });
    expect(built.components?.parameters).toHaveLength(3);
    expect((await data('url-workbench', { action: 'build', baseUrl: parsed.text, parameters: [] })).components?.parameters).toEqual([]);
    expect((await data('url-workbench', { action: 'decode', text: 'a+b%2Bc', mode: 'form' })).text).toBe('a b+c');
    expect((await data('url-workbench', { action: 'decode', text: 'a+b%2Bc', mode: 'component' })).text).toBe('a+b+c');
    expect((await data('url-workbench', { action: 'encode', text: 'a b+c', mode: 'form' })).text).toBe('a+b%2Bc');
    expect((await data('url-workbench', { action: 'encode', text: 'a b+c', mode: 'component' })).text).toBe('a%20b%2Bc');
    await error('url-workbench', { action: 'decode', text: '%ff' });
    await error('url-workbench', { action: 'parse', url: '/relative' });
    await error('url-workbench', { action: 'parse', url: 'https://example.com/?x=%ZZ' });
  });
});

function token(header: string, payload: string, signature = 'AA'): string {
  return `${encodeBase64(readBytes(header, 'utf8'), true, false)}.${encodeBase64(readBytes(payload, 'utf8'), true, false)}.${signature}`;
}

describe('JWT decoding', () => {
  it('returns only unverified claims and keeps unsafe integers intact', async () => {
    const result = await data('jwt-decoder', {
      token: token('{"alg":"HS256"}', '{"exp":0,"nbf":2000000000,"iat":"no","id":9007199254740993123456789}'),
      referenceTime: '2026-01-01T00:00:00Z',
    });
    expect(result.verification).toBe('unverified');
    expect(result.payloadText).toContain('9007199254740993123456789');
    expect(result.claims.map((claim) => claim.status)).toEqual(['past', 'future', 'not-a-timestamp']);
    expect((await data('jwt-decoder', { token: token('{"alg":"none"}', '{}', '') })).signature).toBe('');
  });
  it('rejects bad segments, duplicate keys, nonobject claims and invalid Unicode', async () => {
    for (const value of [
      'a.b', 'a.b.c.d.e', '_w.e30.AA',
      token('{"alg":"HS256"}', '[]'), token('{"alg":"HS256"}', '{"a":1,"a":1}'),
      token('{"alg":"HS256"}', '{}', 'AB'), token('{}', '{}'),
      token('{"alg":"HS256","b64":false}', '{}'),
      token('{"alg":"HS256"}', '{}', ''), token('{"alg":"none"}', '{}'),
      token('{"alg":"HS256"}', '{"bad":"\\ud800"}'),
    ]) await error('jwt-decoder', { token: value });
  });
});

describe('SHA-2 text and streaming files', () => {
  const vectors = {
    'SHA-256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'SHA-384': 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
    'SHA-512': 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  };
  it('matches known SHA-256/384/512 vectors for UTF-8 and hex', async () => {
    for (const inputEncoding of ['utf8', 'hex'] as const) {
      const result = await data('sha-checksums', { text: inputEncoding === 'utf8' ? 'abc' : '616263', inputEncoding, algorithms: ['SHA-256', 'SHA-384', 'SHA-512'] });
      for (const hash of result.hashes) expect(hash.digest).toBe(vectors[hash.algorithm]);
    }
    expect((await data('sha-checksums', { text: '' })).hashes[0]?.digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    await error('sha-checksums', { text: '0', inputEncoding: 'hex' });
    await error('sha-checksums', { text: 'abc', algorithms: ['SHA-256', 'SHA-256'] });
  });
  it('hashes chunks incrementally with byte progress and cancellation', async () => {
    const blob = new Blob(['abc']);
    const progress = vi.fn();
    const result = await hashFile(blob, { algorithms: ['SHA-256'], fileName: 'abc.txt' }, { onProgress: progress });
    expect(result).toMatchObject({ kind: 'result', data: { source: 'file', byteLength: 3, fileName: 'abc.txt', hashes: [{ digest: vectors['SHA-256'] }] } });
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'reading', completed: 0, total: 3, unit: 'bytes' },
      { phase: 'processing', completed: 3, total: 3, unit: 'bytes' },
      { phase: 'complete', completed: 3, total: 3, unit: 'bytes' },
    ]);
    const large = new Blob([new Uint8Array(LIMITS.hashChunkBytes * 2 + 1)]);
    const slice = vi.spyOn(large, 'slice');
    const controller = new AbortController();
    const cancelled = await hashFile(large, undefined, {
      signal: controller.signal,
      onProgress: (event) => { if (event.completed > 0) controller.abort(); },
    });
    expect(cancelled).toMatchObject({ kind: 'error', error: { code: 'ABORTED' } });
    expect(slice).toHaveBeenCalledTimes(1);
    expect(slice).toHaveBeenCalledWith(0, LIMITS.hashChunkBytes);
  });
  it('enforces file cap before reading and propagates unexpected read/callback faults', async () => {
    class Oversized extends Blob { override get size() { return LIMITS.fileBytes + 1; } }
    const file = new Oversized();
    const slice = vi.spyOn(file, 'slice');
    expect(await hashFile(file)).toMatchObject({ kind: 'error', error: { code: 'LIMIT_EXCEEDED' } });
    expect(slice).not.toHaveBeenCalled();
    const faulty = new Blob(['x']);
    vi.spyOn(faulty, 'slice').mockImplementation(() => { throw new Error('I/O bug'); });
    await expect(hashFile(faulty)).rejects.toThrow('I/O bug');
    await expect(hashFile(new Blob(), undefined, { onProgress: () => { throw new Error('callback bug'); } })).rejects.toThrow('callback bug');
  });
});

describe('JavaScript regex and established diff engine', () => {
  it('handles named and unmatched groups, sticky matching, and unicode empty matches', async () => {
    const captures = await data('regex-tester', { pattern: '(?<letter>a)(b)?', text: 'a ab', flags: 'g' });
    expect(captures.matches[0]).toMatchObject({ index: 0, groups: ['a', null], namedGroups: { letter: 'a' } });
    expect((await data('regex-tester', { pattern: '', text: '😀x', flags: 'gu' })).matches.map((m) => m.index)).toEqual([0, 2, 3]);
    expect((await data('regex-tester', { pattern: 'a', text: 'aaa ba', flags: 'y' })).matches).toHaveLength(3);
    expect((await data('regex-tester', { pattern: 'a', text: 'aaa', flags: '' })).matches).toHaveLength(1);
    expect((await data('regex-tester', { pattern: 'a', text: 'aaa', maxMatches: 2 })).truncated).toBe(true);
    expect((await data('regex-tester', { pattern: 'a', text: 'aa', maxMatches: 2 })).truncated).toBe(false);
    await error('regex-tester', { pattern: '(', text: '' });
    await error('regex-tester', { pattern: '', flags: 'gg', text: '' });
    await error('regex-tester', { pattern: '😀'.repeat(2049), text: '' }, 'LIMIT_EXCEEDED');
    await error('regex-tester', { pattern: '', text: '😀'.repeat(51201) }, 'LIMIT_EXCEEDED');
  });
  it('produces useful line/word parts, stats, and unified patches', async () => {
    const result = await data('text-diff', { before: 'a\nold\nz\n', after: 'a\nnew\nz\n', contextLines: 1 });
    expect(result.stats).toEqual({ added: 1, removed: 1, unchanged: 2 });
    expect(result.unified).toContain('-old\n+new');
    expect(result.unified).toContain('@@ -1,3 +1,3 @@');
    const words = await data('text-diff', { before: 'old word', after: 'new word', mode: 'word' });
    expect(words.parts.filter((part) => part.kind !== 'equal').map((part) => part.text)).toEqual(['old', 'new']);
    expect((await data('text-diff', { before: 'a b', after: 'a  b', mode: 'word', ignoreWhitespace: true })).stats.added).toBe(0);
    expect((await data('text-diff', { before: '', after: '' })).parts).toEqual([]);
    await error('text-diff', { before: '😀'.repeat(131073), after: '' }, 'LIMIT_EXCEEDED');
  });
});

describe('timezone-aware cron and epochs', () => {
  it('uses five fields, ranges/names/steps, next ten, and day OR matching', async () => {
    const result = await data('cron-helper', { expression: '*/15 9-17 * JAN,MAR MON-FRI', from: '2026-01-05T14:00:00Z', timezone: 'America/New_York' });
    expect(result.nextRuns).toHaveLength(10);
    expect(result.nextRuns[0]).toMatchObject({ iso: '2026-01-05T14:15:00.000Z', offsetMinutes: -300 });
    expect(result.dayMatching).toBe('or');
    expect((await data('cron-helper', { expression: '0 0 1 * MON', from: '2026-01-02T00:00:00Z', count: 1 })).nextRuns[0]?.iso).toBe('2026-01-05T00:00:00.000Z');
    for (const expression of ['* * * * * *', '0 0 L * *', '0 0 * * ?', '*/0 * * * *', '61 * * * *', '0 0 31 2 *']) {
      await error('cron-helper', { expression });
    }
    await error('cron-helper', { expression: '* * * * *', timezone: 'Not/AZone' });
  });
  it('documents actual spring-forward and fall-back cron-parser behavior', async () => {
    const spring = await data('cron-helper', { expression: '30 2 * * *', timezone: 'America/New_York', from: '2026-03-08T00:00:00Z', count: 2 });
    expect(spring.nextRuns.map((run) => run.iso)).toEqual(['2026-03-08T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
    const fall = await data('cron-helper', { expression: '30 1 * * *', timezone: 'America/New_York', from: '2026-11-01T00:00:00Z', count: 2 });
    expect(fall.nextRuns.map((run) => run.iso)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
    expect(fall.dstPolicy).toBe('cron-parser');
  });
  it('keeps negative fractional epochs and millisecond precision exact', async () => {
    const value = await data('epoch-time', { operation: 'from-epoch', value: '-0.001', unit: 'seconds', timezone: 'UTC' });
    expect(value).toMatchObject({ epochMilliseconds: '-1', epochSeconds: '-0.001', iso: '1969-12-31T23:59:59.999Z', offsetMinutes: 0 });
    const positive = await data('epoch-time', { operation: 'from-iso', value: '2026-09-08T10:39:46.998-05:00', unit: 'milliseconds', timezone: 'Asia/Kathmandu' });
    expect(positive.offsetMinutes).toBe(345);
    expect((await data('epoch-time', { operation: 'from-epoch', value: positive.epochMilliseconds, unit: 'milliseconds' })).iso).toBe(positive.iso);
    expect((await data('epoch-time', { operation: 'from-epoch', value: '-1.2', unit: 'seconds' })).epochMilliseconds).toBe('-1200');
    await error('epoch-time', { operation: 'from-epoch', value: '1.1', unit: 'milliseconds' });
    await error('epoch-time', { operation: 'from-iso', value: '2026-02-30T00:00:00Z', unit: 'seconds' });
    await error('epoch-time', { operation: 'from-iso', value: '2026-01-01T00:00:00', unit: 'seconds' });
    await error('epoch-time', { operation: 'from-iso', value: '2026-01-01T00:00:00.1234Z', unit: 'seconds' });
    await error('epoch-time', { operation: 'from-epoch', value: '8640000000000001', unit: 'milliseconds' });
  });
});

describe('email header analysis', () => {
  it('unfolds fields, decodes MIME words, extracts Received delays, and never claims verification', async () => {
    const headers = [
      'Received: from relay.example by final.example; Tue, 08 Sep 2026 12:00:10 +0000',
      'Received: from sender.example by relay.example; Tue, 08 Sep 2026 12:00:20 +0000',
      'Subject: =?UTF-8?Q?caf=C3=A9?=',
      ' =?UTF-8?B?8J+YgA==?=',
      'From: =?UTF-8?Q?Jos=C3=A9?= <sender@example.com>',
      'To: Person <recipient@example.com>',
      'Authentication-Results: final.example; dkim=pass',
      'Received-SPF: pass',
      'ARC-Authentication-Results: i=1; final.example; dkim=pass',
      'Date: Tue, 08 Sep 2026 12:00:00 +0000',
    ].join('\r\n');
    const result = await data('email-header-analyzer', { headers });
    expect(result.subject).toBe('café😀');
    expect(result.from).toContain('José');
    expect(result.received[0]).toMatchObject({ from: 'relay.example', by: 'final.example', delaySeconds: -10, timestamp: '2026-09-08T12:00:10.000Z' });
    expect(result.authentication).toHaveLength(3);
    expect(result.verification).toBe('not-performed');
    const raw = await executeLocalTool('email-header-analyzer', { headers });
    if (raw.kind === 'result') expect(raw.notices.some((notice) => notice.code === 'CLOCK_SKEW')).toBe(true);
  });
  it('does not guess missing timezone or parse a message body as headers', async () => {
    const result = await data('email-header-analyzer', { headers: 'Received: by host; Tue, 08 Sep 2026 12:00:00\nSubject: hi\n\nbody' });
    expect(result.received[0]?.timestamp).toBeUndefined();
    expect(result.headers).toHaveLength(2);
    await error('email-header-analyzer', { headers: 'no-colon' });
    await error('email-header-analyzer', { headers: ' folded' });
    await error('email-header-analyzer', { headers: '' });
  });
});

describe('facade boundaries', () => {
  it('preserves the ID/input/output relationship without widening the map', () => {
    expectTypeOf(executeLocalTool('chmod', { operation: 'from-octal', value: '755' })).toEqualTypeOf<Promise<import('@domos/contracts').LocalToolResult<'chmod'>>>();
  });
  it('settles pre-aborted operations and rejects unexpected programming faults', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await executeLocalTool('base64', { operation: 'encode', text: 'x' }, { signal: controller.signal })).toMatchObject({ kind: 'error', error: { code: 'ABORTED' } });
    const broken = validated(localInputSchemas.chmod, localResultSchemas.chmod, async () => { throw new Error('Unexpected bug'); });
    await expect(broken({ operation: 'from-octal', value: '755' })).rejects.toThrow('Unexpected bug');
  });
});
