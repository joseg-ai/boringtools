import { z } from 'zod';
import type { LocalToolId } from '@domos/catalog';
import {
  boundedText, instantSchema, LIMITS, localResultSchema, timezoneSchema,
} from './common.js';
import { subnetInputSchema, subnetOutputSchema } from './subnet.js';

export const headerPairSchema = z.strictObject({
  name: boundedText(256),
  value: boundedText(),
});
export const emailHeaderInputSchema = z.strictObject({ headers: boundedText() });
export const emailHeaderOutputSchema = z.strictObject({
  headers: z.array(headerPairSchema).max(2000),
  received: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    raw: boundedText(),
    from: boundedText(4096).optional(),
    by: boundedText(4096).optional(),
    timestamp: instantSchema.optional(),
    delaySeconds: z.number().finite().optional(),
  })).max(1000),
  authentication: z.array(z.strictObject({
    source: z.enum(['authentication-results', 'received-spf', 'arc-authentication-results']),
    value: boundedText(),
  })).max(1000),
  subject: boundedText().optional(),
  from: boundedText().optional(),
  to: boundedText().optional(),
  date: boundedText(4096).optional(),
  verification: z.literal('not-performed'),
});

const octalModeSchema = z.string().regex(/^[0-7]{3,4}$/);
const permissionBitsSchema = z.number().int().min(0).max(7);
const chmodBits = {
  owner: permissionBitsSchema,
  group: permissionBitsSchema,
  other: permissionBitsSchema,
  setuid: z.boolean().default(false),
  setgid: z.boolean().default(false),
  sticky: z.boolean().default(false),
};
export const chmodInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('from-octal'), value: octalModeSchema }),
  z.strictObject({ operation: z.literal('from-bits'), ...chmodBits }),
  z.strictObject({
    operation: z.literal('apply-symbolic'),
    base: octalModeSchema,
    expression: boundedText(256).min(1).regex(
      /^(?:[ugoa]+(?:[+-][rwxst]+|=[rwxst]*))(?:,[ugoa]+(?:[+-][rwxst]+|=[rwxst]*))*$/,
      'Use explicit u/g/o/a targets and +, -, or = with rwxst; conditional X and class copying are not supported',
    ),
  }),
]);
export const chmodOutputSchema = z.strictObject({
  octal: z.string().regex(/^[0-7]{4}$/),
  symbolic: z.string().regex(/^[rwxstST-]{9}$/),
  mode: z.number().int().min(0).max(4095),
  bits: z.strictObject(chmodBits),
  command: boundedText(256),
});

const passwordInput = z.strictObject({
  mode: z.literal('password'),
  length: z.number().int().min(4).max(256).default(20),
  count: z.number().int().min(1).max(20).default(1),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  digits: z.boolean().default(true),
  symbols: z.boolean().default(true),
  excludeAmbiguous: z.boolean().default(false),
  requireEachClass: z.boolean().default(true),
}).refine((value) => value.uppercase || value.lowercase || value.digits || value.symbols, {
  message: 'Select at least one character class',
});
export const passwordInputSchema = z.discriminatedUnion('mode', [
  passwordInput,
  z.strictObject({
    mode: z.literal('passphrase'),
    words: z.number().int().min(4).max(24).default(6),
    count: z.number().int().min(1).max(20).default(1),
    separator: z.string().max(8).regex(/^[\x20-\x7e]*$/).default('-'),
    capitalize: z.boolean().default(false),
  }),
]);
export const PASSWORD_ALPHABETS = Object.freeze({
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
  ambiguous: 'Il1O0o',
});
export const passwordOutputSchema = z.strictObject({
  values: z.array(boundedText(4096)).min(1).max(20),
  entropyBits: z.number().finite().nonnegative(),
  entropyLabel: z.enum(['exact', 'lower-bound']),
  alphabetSize: z.number().int().positive(),
  wordlist: z.literal('scure-bip39/english').nullable(),
  randomness: z.literal('cryptographic'),
});

export const dataFormatSchema = z.enum(['json', 'yaml']);
export const jsonYamlInputSchema = z.strictObject({
  text: boundedText(),
  source: dataFormatSchema,
  action: z.enum(['validate', 'format', 'minify', 'convert']),
  target: dataFormatSchema.optional(),
  indent: z.union([z.literal(2), z.literal(4)]).default(2),
}).superRefine((input, ctx) => {
  if (input.action === 'convert' && !input.target) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'Conversion requires an explicit target format' });
  }
  if (input.action !== 'convert' && input.target) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'Target is only valid for conversion' });
  }
  if (input.action === 'minify' && input.source !== 'json') {
    ctx.addIssue({ code: 'custom', path: ['action'], message: 'Minify is only supported for JSON' });
  }
});
export const jsonYamlOutputSchema = z.strictObject({
  valid: z.literal(true),
  format: dataFormatSchema,
  text: boundedText(LIMITS.outputBytes).nullable(),
  changed: z.boolean(),
  comments: z.enum(['preserved', 'removed', 'not-applicable']),
});
export const STRUCTURED_DATA_LIMITS = Object.freeze({ depth: 64, nodes: 50_000, aliases: 50 });

// byteFormat describes the raw side: encoding interprets it; decoding emits it.
// padding controls encode output only. Decode accepts valid padded or unpadded input.
export const base64InputSchema = z.strictObject({
  operation: z.enum(['encode', 'decode']),
  text: boundedText(),
  byteFormat: z.enum(['utf8', 'hex']).default('utf8'),
  alphabet: z.enum(['standard', 'url-safe']).default('standard'),
  padding: z.boolean().default(true),
});
export const base64OutputSchema = z.strictObject({
  text: boundedText(LIMITS.outputBytes),
  byteLength: z.number().int().nonnegative(),
  format: z.enum(['base64', 'utf8', 'hex']),
});

export const queryParameterSchema = z.strictObject({
  name: boundedText(8192),
  value: boundedText(8192),
});
export const urlInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('parse'), url: boundedText(16_384).min(1) }),
  z.strictObject({
    action: z.literal('build'),
    baseUrl: boundedText(16_384).min(1),
    parameters: z.array(queryParameterSchema).max(1000),
    replaceQuery: z.boolean().default(true),
  }),
  z.strictObject({
    action: z.literal('encode'),
    text: boundedText(),
    mode: z.enum(['component', 'form']).default('component'),
  }),
  z.strictObject({
    action: z.literal('decode'),
    text: boundedText(),
    mode: z.enum(['component', 'form']).default('component'),
  }),
]);
export const urlComponentsSchema = z.strictObject({
  protocol: z.string(),
  username: z.string(),
  password: z.string(),
  hostname: z.string(),
  port: z.string(),
  pathname: z.string(),
  search: z.string(),
  hash: z.string(),
  origin: z.string(),
  parameters: z.array(queryParameterSchema).max(1000),
});
export const urlOutputSchema = z.strictObject({
  text: boundedText(LIMITS.outputBytes),
  components: urlComponentsSchema.nullable(),
});

export const jwtInputSchema = z.strictObject({
  token: boundedText().min(1),
  referenceTime: instantSchema.default(() => new Date().toISOString()),
});
export const jwtOutputSchema = z.strictObject({
  headerText: boundedText(),
  payloadText: boundedText(),
  signature: boundedText(),
  verification: z.literal('unverified'),
  claims: z.array(z.strictObject({
    name: z.enum(['exp', 'nbf', 'iat']),
    rawValue: boundedText(4096),
    isoTime: instantSchema.nullable(),
    status: z.enum(['past', 'future', 'not-a-timestamp']),
  })).max(3),
});

export const hashAlgorithmSchema = z.enum(['SHA-256', 'SHA-384', 'SHA-512']);
const hashAlgorithmsSchema = z.array(hashAlgorithmSchema).min(1).max(3)
  .refine((items) => new Set(items).size === items.length, { message: 'Algorithms must be unique' })
  .default(['SHA-256']);
export const shaInputSchema = z.strictObject({
  text: boundedText(),
  inputEncoding: z.enum(['utf8', 'hex']).default('utf8'),
  algorithms: hashAlgorithmsSchema,
});
export const hashFileOptionsSchema = z.strictObject({
  algorithms: hashAlgorithmsSchema,
  fileName: boundedText(255).optional(),
});
export const hashValueSchema = z.strictObject({
  algorithm: hashAlgorithmSchema,
  digest: z.string().regex(/^[a-f0-9]+$/),
}).refine(({ algorithm, digest }) => digest.length === Number(algorithm.slice(4)) / 4, {
  message: 'Digest length must match its SHA algorithm',
});
export const shaOutputSchema = z.strictObject({
  source: z.enum(['text', 'file']),
  byteLength: z.number().int().min(0).max(LIMITS.fileBytes),
  hashes: z.array(hashValueSchema).min(1).max(3),
  fileName: boundedText(255).optional(),
});
export type HashFileOptions = z.input<typeof hashFileOptionsSchema>;
export type HashAlgorithm = z.infer<typeof hashAlgorithmSchema>;

export const regexFlagsSchema = z.string().regex(/^[dgimsuvy]*$/)
  .refine((flags) => new Set(flags).size === flags.length, { message: 'Flags must be unique' })
  .refine((flags) => !(flags.includes('u') && flags.includes('v')), { message: 'u and v cannot be combined' });
export const regexInputSchema = z.strictObject({
  pattern: boundedText(LIMITS.regexPatternBytes),
  text: boundedText(LIMITS.regexTextBytes),
  flags: regexFlagsSchema.default('g'),
  maxMatches: z.number().int().min(1).max(LIMITS.regexMatches).default(LIMITS.regexMatches),
});
export const regexOutputSchema = z.strictObject({
  matches: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    text: boundedText(LIMITS.regexTextBytes),
    groups: z.array(boundedText(LIMITS.regexTextBytes).nullable()).max(1000),
    namedGroups: z.record(z.string(), boundedText(LIMITS.regexTextBytes).nullable()),
  })).max(LIMITS.regexMatches),
  truncated: z.boolean(),
  flags: regexFlagsSchema,
});

export const diffInputSchema = z.strictObject({
  before: boundedText(LIMITS.diffSideBytes),
  after: boundedText(LIMITS.diffSideBytes),
  mode: z.enum(['line', 'word']).default('line'),
  ignoreWhitespace: z.boolean().default(false),
  contextLines: z.number().int().min(0).max(20).default(3),
});
export const diffOutputSchema = z.strictObject({
  parts: z.array(z.strictObject({
    kind: z.enum(['equal', 'added', 'removed']),
    text: boundedText(LIMITS.outputBytes),
    count: z.number().int().nonnegative(),
  })).max(LIMITS.diffParts),
  unified: boundedText(LIMITS.outputBytes),
  stats: z.strictObject({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
});

const cronFieldAtoms = [
  '\\d+', '\\d+', '\\d+',
  '(?:\\d+|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)',
  '(?:\\d+|SUN|MON|TUE|WED|THU|FRI|SAT)',
];
const cronFieldPatterns = cronFieldAtoms.map((atom) => {
  const item = `(?:\\*|${atom})(?:-${atom})?(?:/\\d+)?`;
  return new RegExp(`^${item}(?:,${item})*$`, 'i');
});
export const cronInputSchema = z.strictObject({
  expression: z.string().trim().min(1).max(256)
    .refine((text) => text.split(/\s+/).length === 5, { message: 'Exactly five cron fields are required' })
    .refine((text) => text.split(/\s+/).every((field, index) => cronFieldPatterns[index]?.test(field)), {
      message: 'Use standard ranges, lists, steps and month/day names; extensions are not supported',
    }),
  timezone: timezoneSchema.default('UTC'),
  from: instantSchema.default(() => new Date().toISOString()),
  count: z.number().int().min(1).max(25).default(10),
});
export const zonedInstantSchema = z.strictObject({
  iso: instantSchema,
  local: boundedText(256),
  offsetMinutes: z.number().int().min(-24 * 60).max(24 * 60),
});
export const cronOutputSchema = z.strictObject({
  expression: z.string(),
  timezone: timezoneSchema,
  description: boundedText(4096),
  nextRuns: z.array(zonedInstantSchema).min(1).max(25),
  dayMatching: z.literal('or'),
  dstPolicy: z.literal('cron-parser'),
});

const epochUnitSchema = z.enum(['seconds', 'milliseconds']);
export const epochInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('from-epoch'),
    value: z.string().regex(/^-?\d+(?:\.\d{1,3})?$/).max(32),
    unit: epochUnitSchema,
    timezone: timezoneSchema.default('UTC'),
  }).refine(({ value, unit }) => unit === 'seconds' || !value.includes('.'), {
    message: 'Milliseconds must be an integer; fractional seconds support millisecond precision',
    path: ['value'],
  }),
  z.strictObject({
    operation: z.literal('from-iso'),
    value: instantSchema.refine((value) => !/\.\d{4,}/.test(value), {
      message: 'ISO timestamps support at most millisecond precision',
    }),
    unit: epochUnitSchema,
    timezone: timezoneSchema.default('UTC'),
  }),
]);
export const epochOutputSchema = z.strictObject({
  epochSeconds: z.string().regex(/^-?\d+(?:\.\d{1,3})?$/),
  epochMilliseconds: z.string().regex(/^-?\d+$/),
  iso: instantSchema,
  local: boundedText(256),
  timezone: timezoneSchema,
  offsetMinutes: z.number().int().min(-24 * 60).max(24 * 60),
});

export const localInputSchemas = {
  'ipv4-subnet-planner': subnetInputSchema,
  'email-header-analyzer': emailHeaderInputSchema,
  chmod: chmodInputSchema,
  'password-generator': passwordInputSchema,
  'json-yaml-workbench': jsonYamlInputSchema,
  base64: base64InputSchema,
  'url-workbench': urlInputSchema,
  'jwt-decoder': jwtInputSchema,
  'sha-checksums': shaInputSchema,
  'regex-tester': regexInputSchema,
  'text-diff': diffInputSchema,
  'cron-helper': cronInputSchema,
  'epoch-time': epochInputSchema,
} satisfies Record<LocalToolId, z.ZodType>;

export const localOutputSchemas = {
  'ipv4-subnet-planner': subnetOutputSchema,
  'email-header-analyzer': emailHeaderOutputSchema,
  chmod: chmodOutputSchema,
  'password-generator': passwordOutputSchema,
  'json-yaml-workbench': jsonYamlOutputSchema,
  base64: base64OutputSchema,
  'url-workbench': urlOutputSchema,
  'jwt-decoder': jwtOutputSchema,
  'sha-checksums': shaOutputSchema,
  'regex-tester': regexOutputSchema,
  'text-diff': diffOutputSchema,
  'cron-helper': cronOutputSchema,
  'epoch-time': epochOutputSchema,
} satisfies Record<LocalToolId, z.ZodType>;

export const localResultSchemas = {
  'ipv4-subnet-planner': localResultSchema(subnetOutputSchema),
  'email-header-analyzer': localResultSchema(emailHeaderOutputSchema),
  chmod: localResultSchema(chmodOutputSchema),
  'password-generator': localResultSchema(passwordOutputSchema),
  'json-yaml-workbench': localResultSchema(jsonYamlOutputSchema),
  base64: localResultSchema(base64OutputSchema),
  'url-workbench': localResultSchema(urlOutputSchema),
  'jwt-decoder': localResultSchema(jwtOutputSchema),
  'sha-checksums': localResultSchema(shaOutputSchema),
  'regex-tester': localResultSchema(regexOutputSchema),
  'text-diff': localResultSchema(diffOutputSchema),
  'cron-helper': localResultSchema(cronOutputSchema),
  'epoch-time': localResultSchema(epochOutputSchema),
} satisfies Record<LocalToolId, z.ZodType>;

export type LocalToolInput<K extends LocalToolId> = z.input<(typeof localInputSchemas)[K]>;
export type ResolvedLocalToolInput<K extends LocalToolId> = z.output<(typeof localInputSchemas)[K]>;
export type LocalToolOutput<K extends LocalToolId> = z.output<(typeof localOutputSchemas)[K]>;
export type LocalToolResult<K extends LocalToolId> = z.output<(typeof localResultSchemas)[K]>;
export type LocalToolInputMap = { [K in LocalToolId]: LocalToolInput<K> };
export type LocalToolOutputMap = { [K in LocalToolId]: LocalToolOutput<K> };
