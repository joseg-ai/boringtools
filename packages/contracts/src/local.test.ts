import { describe, expect, expectTypeOf, it } from 'vitest';
import { LOCAL_TOOL_IDS } from '@domos/catalog';
import {
  boundedText, hashFileInputSchema, LIMITS, progressSchema, localInputSchemas, localOutputSchemas,
  localResultSchemas, subnetInputSchema, subnetStateSchema,
  workerRequestSchema, workerResponseSchema,
  type ExecuteLocalTool, type HashFile, type LocalToolInputMap,
  type LocalToolOutputMap, type LocalToolResult, type SubnetState,
} from './index.js';

const state: SubnetState = {
  version: 1,
  rootCidr: '192.0.2.0/32',
  allocations: [{ cidr: '192.0.2.0/32', note: '', color: 'teal' }],
};

// Shape fixtures only: these are not substitute implementations or live results.
const inputs = {
  'ipv4-subnet-planner': { action: 'create', cidr: '192.0.2.0/32' },
  'email-header-analyzer': { headers: 'Subject: Example\r\n' },
  chmod: { operation: 'from-octal', value: '0755' },
  'password-generator': { mode: 'password' },
  'json-yaml-workbench': { text: '{"n":9007199254740993}', source: 'json', action: 'validate' },
  base64: { operation: 'encode', text: 'hello' },
  'url-workbench': { action: 'parse', url: 'https://example.com/?a=1&a=2' },
  'jwt-decoder': { token: 'e30.e30.' },
  'sha-checksums': { text: 'hello' },
  'regex-tester': { pattern: 'a', text: 'a' },
  'text-diff': { before: 'before', after: 'after' },
  'cron-helper': { expression: '0 12 * * MON' },
  'epoch-time': { operation: 'from-epoch', value: '0', unit: 'seconds' },
} satisfies LocalToolInputMap;

const outputs = {
  'ipv4-subnet-planner': {
    state,
    rows: [{
      cidr: '192.0.2.0/32', prefix: 32, network: '192.0.2.0', broadcast: null,
      firstAddress: '192.0.2.0', lastAddress: '192.0.2.0',
      firstUsable: '192.0.2.0', lastUsable: '192.0.2.0',
      totalAddresses: '1', usableHosts: '1', semantics: 'host', note: '', color: 'teal',
    }],
  },
  'email-header-analyzer': {
    headers: [{ name: 'Subject', value: 'Example' }],
    received: [], authentication: [], verification: 'not-performed',
  },
  chmod: {
    octal: '0755', symbolic: 'rwxr-xr-x', mode: 493,
    bits: { owner: 7, group: 5, other: 5, setuid: false, setgid: false, sticky: false },
    command: 'chmod 0755',
  },
  'password-generator': {
    values: ['example'], entropyBits: 80, entropyLabel: 'lower-bound',
    alphabetSize: 64, wordlist: null, randomness: 'cryptographic',
  },
  'json-yaml-workbench': {
    valid: true, format: 'json', text: null, changed: false, comments: 'not-applicable',
  },
  base64: { text: 'aGVsbG8=', byteLength: 5, format: 'base64' },
  'url-workbench': { text: '%20', components: null },
  'jwt-decoder': { headerText: '{}', payloadText: '{}', signature: '', verification: 'unverified', claims: [] },
  'sha-checksums': {
    source: 'text', byteLength: 5, hashes: [{ algorithm: 'SHA-256', digest: 'a'.repeat(64) }],
  },
  'regex-tester': { matches: [{ index: 0, text: 'a', groups: [], namedGroups: {} }], truncated: false, flags: 'g' },
  'text-diff': {
    parts: [{ kind: 'equal', text: 'a', count: 1 }], unified: '',
    stats: { added: 0, removed: 0, unchanged: 1 },
  },
  'cron-helper': {
    expression: '0 12 * * MON', timezone: 'UTC', description: 'A five-field schedule',
    nextRuns: [{ iso: '2026-09-14T12:00:00Z', local: '2026-09-14 12:00:00 UTC', offsetMinutes: 0 }],
    dayMatching: 'or', dstPolicy: 'cron-parser',
  },
  'epoch-time': {
    epochSeconds: '0', epochMilliseconds: '0', iso: '1970-01-01T00:00:00.000Z',
    local: '1970-01-01 00:00:00 UTC', timezone: 'UTC', offsetMinutes: 0,
  },
} satisfies LocalToolOutputMap;

describe('local tool contracts', () => {
  it('covers exactly every local tool on all schema surfaces', () => {
    for (const schemas of [localInputSchemas, localOutputSchemas, localResultSchemas]) {
      expect(Object.keys(schemas).sort()).toEqual([...LOCAL_TOOL_IDS].sort());
    }
  });

  it.each(LOCAL_TOOL_IDS)('%s accepts its typed input/output and rejects extra properties', (id) => {
    expect(localInputSchemas[id].safeParse(inputs[id]).success).toBe(true);
    expect(localOutputSchemas[id].safeParse(outputs[id]).success).toBe(true);
    expect(localInputSchemas[id].safeParse({ ...inputs[id], unexpected: true }).success).toBe(false);
    expect(localOutputSchemas[id].safeParse({ ...outputs[id], unexpected: true }).success).toBe(false);
    expect(localResultSchemas[id].safeParse({ kind: 'result', data: outputs[id], notices: [] }).success).toBe(true);
    expect(localResultSchemas[id].safeParse({ kind: 'error', error: { code: 'ABORTED', message: 'Cancelled' } }).success).toBe(true);
    expect(localResultSchemas[id].safeParse({ kind: 'result', data: outputs[id] }).success).toBe(false);
  });

  it('provides stable defaults rather than relying on UI guesses', () => {
    expect(localInputSchemas['password-generator'].parse({ mode: 'password' })).toEqual({
      mode: 'password', length: 20, count: 1,
      uppercase: true, lowercase: true, digits: true, symbols: true,
      excludeAmbiguous: false, requireEachClass: true,
    });
    expect(localInputSchemas['password-generator'].parse({ mode: 'passphrase' })).toEqual({
      mode: 'passphrase', words: 6, count: 1, separator: '-', capitalize: false,
    });
    expect(localInputSchemas['sha-checksums'].parse({ text: '' })).toEqual({
      text: '', inputEncoding: 'utf8', algorithms: ['SHA-256'],
    });
    expect(localInputSchemas['regex-tester'].parse({ pattern: '', text: '' })).toEqual({
      pattern: '', text: '', flags: 'g', maxMatches: 1000,
    });
    const cron = localInputSchemas['cron-helper'].parse({ expression: '* * * * *' });
    expect(cron).toMatchObject({ timezone: 'UTC', count: 10 });
    expect(Date.parse(cron.from)).toBeGreaterThan(0);
  });

  it('enforces UTF-8 byte caps, not just string lengths', () => {
    expect(boundedText(4).safeParse('aaaa').success).toBe(true);
    expect(boundedText(4).safeParse('\u00e9\u00e9').success).toBe(true);
    expect(boundedText(4).safeParse('\u00e9\u00e9a').success).toBe(false);
    expect(localInputSchemas['regex-tester'].safeParse({
      pattern: 'a', text: 'x'.repeat(LIMITS.regexTextBytes + 1),
    }).success).toBe(false);
  });

  it('caps the complete local result, including repeated diff pieces', () => {
    expect(localResultSchemas['text-diff'].safeParse({
      kind: 'result',
      data: {
        parts: Array.from({ length: 3 }, () => ({ kind: 'equal', text: 'a'.repeat(400_000), count: 1 })),
        unified: 'b'.repeat(1_000_000),
        stats: { added: 0, removed: 0, unchanged: 3 },
      },
      notices: [],
    }).success).toBe(false);
  });

  it.each(['gg', 'uv', 'x'])('rejects invalid regex flag combination %s', (flags) => {
    expect(localInputSchemas['regex-tester'].safeParse({ pattern: 'a', text: 'a', flags }).success).toBe(false);
  });

  it.each([
    '0 0 12 * * *', '@daily', '* * L * *', '* * * * MON#2',
    '* * * * 5L', '* * 1W * *', '* * ? * MON',
  ])('rejects non-five-field or extended cron syntax %s', (expression) => {
    expect(localInputSchemas['cron-helper'].safeParse({ expression }).success).toBe(false);
  });

  it.each(['*/5 * * * *', '0 12 1-5 JAN,MAR MON-FRI', '0 0 * JUL SUN'])(
    'accepts standard cron fields %s', (expression) => {
      expect(localInputSchemas['cron-helper'].safeParse({ expression }).success).toBe(true);
    },
  );

  it('requires explicit epoch units and unambiguous ISO instants', () => {
    const schema = localInputSchemas['epoch-time'];
    expect(schema.safeParse({ operation: 'from-epoch', value: '123' }).success).toBe(false);
    expect(schema.safeParse({ operation: 'from-epoch', value: '-0.001', unit: 'seconds' }).success).toBe(true);
    expect(schema.safeParse({ operation: 'from-epoch', value: '0.1', unit: 'milliseconds' }).success).toBe(false);
    expect(schema.safeParse({ operation: 'from-iso', value: '2026-11-01T01:30:00', unit: 'seconds' }).success).toBe(false);
    expect(schema.safeParse({ operation: 'from-iso', value: '2026-11-01T01:30:00-04:00', unit: 'seconds' }).success).toBe(true);
    expect(schema.safeParse({ operation: 'from-iso', value: '2026-01-01T00:00:00.1234Z', unit: 'seconds' }).success).toBe(false);
    expect(schema.safeParse({ ...inputs['epoch-time'], timezone: 'Invalid/Zone' }).success).toBe(false);
  });

  it('requires an explicit conversion target and rejects YAML minify', () => {
    const schema = localInputSchemas['json-yaml-workbench'];
    expect(schema.safeParse({ text: '{}', source: 'json', action: 'convert' }).success).toBe(false);
    expect(schema.safeParse({ text: '{}', source: 'yaml', action: 'minify' }).success).toBe(false);
    expect(schema.safeParse({ text: '{}', source: 'json', action: 'convert', target: 'yaml' }).success).toBe(true);
  });

  it('requires a starting mode and explicitly supported symbolic chmod syntax', () => {
    const schema = localInputSchemas.chmod;
    expect(schema.safeParse({ operation: 'apply-symbolic', expression: 'u+x' }).success).toBe(false);
    expect(schema.safeParse({ operation: 'apply-symbolic', base: '644', expression: 'u+x,g=rx,o=' }).success).toBe(true);
    expect(schema.safeParse({ operation: 'apply-symbolic', base: '644', expression: 'a+X' }).success).toBe(false);
  });

  it('requires a charset and rejects duplicate SHA algorithms or incorrect digests', () => {
    expect(localInputSchemas['password-generator'].safeParse({
      mode: 'password', uppercase: false, lowercase: false, digits: false, symbols: false,
    }).success).toBe(false);
    expect(localInputSchemas['sha-checksums'].safeParse({
      text: '', algorithms: ['SHA-256', 'SHA-256'],
    }).success).toBe(false);
    expect(localOutputSchemas['sha-checksums'].safeParse({
      source: 'text', byteLength: 0, hashes: [{ algorithm: 'SHA-512', digest: 'a'.repeat(64) }],
    }).success).toBe(false);
  });

  it('rejects nested unknown properties and false verification claims', () => {
    expect(localOutputSchemas['jwt-decoder'].safeParse({
      ...outputs['jwt-decoder'], verification: 'verified',
    }).success).toBe(false);
    expect(localOutputSchemas['email-header-analyzer'].safeParse({
      ...outputs['email-header-analyzer'], verification: 'verified',
    }).success).toBe(false);
    expect(localInputSchemas['url-workbench'].safeParse({
      action: 'build', baseUrl: 'https://example.com',
      parameters: [{ name: 'a', value: '1', extra: true }],
    }).success).toBe(false);
  });
});

describe('subnet and worker boundaries', () => {
  it('provides versioned state and all six allocation commands', () => {
    expect(subnetStateSchema.safeParse(state).success).toBe(true);
    const commands = [
      { action: 'create', cidr: '0.0.0.0/0' },
      { action: 'split', state, cidr: '192.0.2.0/32' },
      { action: 'join', state, cidrs: ['192.0.2.0/32', '192.0.2.1/32'] },
      { action: 'annotate', state, cidr: '192.0.2.0/32', annotation: { note: 'Host', color: 'blue' } },
      { action: 'import', json: JSON.stringify(state) },
      { action: 'export', state, format: 'json' },
    ];
    for (const command of commands) expect(subnetInputSchema.safeParse(command).success).toBe(true);
    expect(subnetStateSchema.safeParse({ ...state, version: 2 }).success).toBe(false);
    expect(subnetStateSchema.safeParse({
      ...state, allocations: [{ ...state.allocations[0], hidden: true }],
    }).success).toBe(false);
    expect(subnetInputSchema.safeParse({ action: 'create', cidr: '999.0.0.1/24' }).success).toBe(false);
    expect(subnetInputSchema.safeParse({ action: 'create', cidr: '192.0.2.0/33' }).success).toBe(false);
  });

  it('requires bounded monotonic progress values', () => {
    expect(progressSchema.safeParse({ phase: 'reading', completed: 0, total: 0, unit: 'bytes' }).success).toBe(true);
    expect(progressSchema.safeParse({ phase: 'reading', completed: 2, total: 1, unit: 'bytes' }).success).toBe(false);
  });

  it('validates actual Blob jobs, options and strict worker message shapes', () => {
    const file = new Blob(['hello']);
    expect(hashFileInputSchema.parse({ file }).options.algorithms).toEqual(['SHA-256']);
    expect(hashFileInputSchema.safeParse({ file: 'not a Blob' }).success).toBe(false);
    expect(workerRequestSchema.safeParse({
      kind: 'hash-file', jobId: 'hash-1', file, options: { algorithms: ['SHA-512'] },
    }).success).toBe(true);
    expect(workerRequestSchema.safeParse({
      kind: 'run', jobId: 'regex-1', toolId: 'regex-tester', input: { pattern: '.', text: 'a' },
    }).success).toBe(true);
    expect(workerRequestSchema.safeParse({
      kind: 'run', jobId: 'regex-1', toolId: 'regex-tester', input: { pattern: '.', text: 'a' }, extra: true,
    }).success).toBe(false);
    expect(workerResponseSchema.safeParse({
      kind: 'complete', jobId: 'regex-1', toolId: 'regex-tester',
      result: { kind: 'error', error: { code: 'TIMEOUT', message: 'Worker deadline exceeded' } },
    }).success).toBe(true);
    expect(workerResponseSchema.safeParse({
      kind: 'complete', jobId: 'regex-1', toolId: 'regex-tester',
      result: { kind: 'result', data: outputs['text-diff'], notices: [] },
    }).success).toBe(false);
  });

  it('accepts the file byte boundary and rejects one byte over before any read', () => {
    const chunk = new Blob([new Uint8Array(LIMITS.hashChunkBytes)]);
    const atLimit = new Blob(Array<Blob>(LIMITS.fileBytes / LIMITS.hashChunkBytes).fill(chunk));
    const overLimit = new Blob([atLimit, 'x']);
    expect(atLimit.size).toBe(LIMITS.fileBytes);
    expect(hashFileInputSchema.safeParse({ file: atLimit }).success).toBe(true);
    expect(hashFileInputSchema.safeParse({ file: overLimit }).success).toBe(false);
  });

  it('preserves the generic facade and cancellable Blob hashing signatures', () => {
    expectTypeOf<ReturnType<HashFile>>().toEqualTypeOf<Promise<LocalToolResult<'sha-checksums'>>>();
    expectTypeOf<Parameters<HashFile>[0]>().toEqualTypeOf<Blob>();
    expectTypeOf<ExecuteLocalTool>().toBeFunction();
  });
});
