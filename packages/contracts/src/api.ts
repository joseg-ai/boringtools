import { z } from 'zod';
import { boundedText, CONTRACT_VERSION, inputIssueSchema, instantSchema, jsonWithinByteLimit, LIMITS } from './common.js';
import { ipv4Schema } from './subnet.js';

export const API_ROUTES = Object.freeze({
  dns: '/api/v1/dns',
  emailPolicy: '/api/v1/email-policy',
  http: '/api/v1/http',
});
export const LIVE_TOOL_OPERATIONS = Object.freeze({
  'dns-explorer': 'dns',
  'email-dns-policy': 'emailPolicy',
  'http-inspector': 'http',
} as const);
export const HEALTH_PATH = '/healthz';

// Configuration only: never accept a submitted tool target as the API origin.
export const apiOriginSchema = z.url({ protocol: /^https?$/ }).pipe(z.string().refine((value) => {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return value === url.origin
    && (url.protocol === 'https:' || loopback);
}, { message: 'Use an exact HTTPS origin without a path, credentials or trailing slash; HTTP is local-only' }));

export const apiErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'TARGET_BLOCKED', 'RATE_LIMITED', 'UPSTREAM_ERROR',
  'TIMEOUT', 'LIMIT_EXCEEDED', 'NOT_READY', 'NOT_FOUND',
  'METHOD_NOT_ALLOWED', 'UNSUPPORTED_MEDIA_TYPE', 'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export const API_ERROR_HTTP_STATUS = Object.freeze({
  INVALID_INPUT: 400,
  TARGET_BLOCKED: 422,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
  LIMIT_EXCEEDED: 413,
  NOT_READY: 503,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ApiErrorCode, number>);

export const apiErrorSchema = z.strictObject({
  code: apiErrorCodeSchema,
  phase: z.enum(['validation', 'policy', 'dns', 'connect', 'tls', 'headers', 'service']),
  message: boundedText(4096),
  issues: z.array(inputIssueSchema).max(100).optional(),
  retryAfterSeconds: z.number().int().positive().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export const reportMetaSchema = z.strictObject({
  requestId: z.string().min(1).max(100),
  observedAt: instantSchema,
  elapsedMs: z.number().finite().nonnegative(),
  policyVersion: z.string().min(1).max(80),
});
export type ReportMeta = z.infer<typeof reportMetaSchema>;

// result and partial use HTTP 200. Error-only replies use API_ERROR_HTTP_STATUS.
// A partial reply must include observed data AND its stopping/failure reason.
export function apiReplySchema<S extends z.ZodType>(data: S) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('result'), data, meta: reportMetaSchema }),
    z.strictObject({ kind: z.literal('partial'), data, error: apiErrorSchema, meta: reportMetaSchema }),
    z.strictObject({ kind: z.literal('error'), error: apiErrorSchema, meta: reportMetaSchema }),
  ]).refine((value) => jsonWithinByteLimit(value, LIMITS.apiResponseBytes), {
    message: `Serialized API reply must not exceed ${LIMITS.apiResponseBytes} bytes`,
  });
}
export type ApiReply<T> =
  | { kind: 'result'; data: T; meta: ReportMeta }
  | { kind: 'partial'; data: T; error: ApiError; meta: ReportMeta }
  | { kind: 'error'; error: ApiError; meta: ReportMeta };

const hostnameLabel = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const dnsLabel = '[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?';
export const domainSchema = z.string().trim().min(1).max(253)
  .regex(new RegExp(`^${hostnameLabel}(?:\\.${hostnameLabel})*\\.?$`));
export const dnsNameSchema = z.string().trim().min(1).max(253)
  .regex(new RegExp(`^${dnsLabel}(?:\\.${dnsLabel})*\\.?$`));
export const dnsTypeSchema = z.enum(['A', 'AAAA', 'MX', 'CNAME', 'NS', 'TXT', 'SOA', 'PTR']);
export type DnsType = z.infer<typeof dnsTypeSchema>;
export const dnsRequestSchema = z.strictObject({
  name: z.union([dnsNameSchema, z.ipv6()]),
  types: z.array(dnsTypeSchema).min(1).max(8)
    .refine((types) => new Set(types).size === types.length, { message: 'Record types must be unique' }),
});
export const emailPolicyRequestSchema = z.strictObject({
  domain: domainSchema,
  dkimSelector: domainSchema.pipe(z.string().max(63)).optional(),
});

// This validates request syntax, not public-address eligibility. The API must
// independently validate and pin every destination and every redirect hop.
export const httpRequestSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  method: z.enum(['HEAD', 'GET']).default('HEAD'),
});

const uint32 = z.number().int().min(0).max(4_294_967_295);
const dnsRecordBase = { name: z.string().max(253), ttl: uint32 };
const targetName = z.string().max(253);
export const dnsRecordSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...dnsRecordBase, type: z.literal('A'), address: ipv4Schema }),
  z.strictObject({ ...dnsRecordBase, type: z.literal('AAAA'), address: z.ipv6() }),
  z.strictObject({
    ...dnsRecordBase, type: z.literal('MX'), exchange: targetName,
    preference: z.number().int().min(0).max(65_535),
  }),
  z.strictObject({ ...dnsRecordBase, type: z.literal('CNAME'), target: targetName }),
  z.strictObject({ ...dnsRecordBase, type: z.literal('NS'), target: targetName }),
  z.strictObject({ ...dnsRecordBase, type: z.literal('PTR'), target: targetName }),
  z.strictObject({
    ...dnsRecordBase, type: z.literal('TXT'),
    chunks: z.array(boundedText(4096)).max(256),
  }),
  z.strictObject({
    ...dnsRecordBase, type: z.literal('SOA'),
    mname: targetName, rname: targetName, serial: uint32,
    refresh: uint32, retry: uint32, expire: uint32, minimum: uint32,
  }),
]);
export type DnsRecord = z.infer<typeof dnsRecordSchema>;
export const dnsOutcomeSchema = z.union([
  z.strictObject({
    type: dnsTypeSchema, status: z.literal('answer'), rcode: z.literal(0),
    records: z.array(dnsRecordSchema).min(1).max(128),
  }),
  z.strictObject({
    type: dnsTypeSchema, status: z.literal('negative'),
    reason: z.literal('NXDOMAIN'), rcode: z.literal(3),
  }),
  z.strictObject({
    type: dnsTypeSchema, status: z.literal('negative'),
    reason: z.literal('NODATA'), rcode: z.literal(0),
  }),
  z.strictObject({
    type: dnsTypeSchema, status: z.literal('error'),
    rcode: z.number().int().min(0).max(15).nullable(),
    error: apiErrorSchema,
  }),
]);
export type DnsOutcome = z.infer<typeof dnsOutcomeSchema>;
export const dnsReportSchema = z.strictObject({
  name: z.string().min(1).max(253),
  resolver: z.string().min(1).max(256),
  queries: z.array(dnsOutcomeSchema).min(1).max(8),
});
export type DnsReport = z.infer<typeof dnsReportSchema>;

export const policyFindingSchema = z.strictObject({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string().min(1).max(80),
  message: boundedText(4096),
});
const policyStatusSchema = z.enum(['present', 'absent', 'invalid', 'indeterminate']);
const policyRecords = z.array(boundedText(16_384)).max(32);
const policyFindings = z.array(policyFindingSchema).max(100);
function checkPolicyPresence(
  policy: { status: string; records: string[] },
  ctx: z.RefinementCtx,
) {
  if (['present', 'invalid'].includes(policy.status) && policy.records.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['records'], message: 'A present or invalid policy requires observed records' });
  }
  if (policy.status === 'absent' && policy.records.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['records'], message: 'An absent policy cannot have policy records' });
  }
}
const policyBase = {
  status: policyStatusSchema,
  owner: z.string().min(1).max(253),
  records: policyRecords,
  findings: policyFindings,
};
export const spfReportSchema = z.strictObject({
  ...policyBase,
  dependencies: z.array(z.strictObject({
    from: z.string().max(253),
    to: z.string().max(1024),
    mechanism: z.enum(['include', 'redirect']),
    status: z.enum(['observed', 'unresolved', 'cycle', 'limit', 'macro']),
  })).max(LIMITS.emailQueries),
  // Exploration DNS requests, not the RFC 7208 ten-term evaluation limit.
  lookupCount: z.number().int().min(0).max(LIMITS.emailQueries),
  // Complete traversal of the inspected static graph, never sender authentication.
  complete: z.boolean(),
  unevaluated: z.array(boundedText(4096)).max(100),
}).superRefine(checkPolicyPresence);
export const dmarcReportSchema = z.strictObject({
  ...policyBase,
  policy: z.enum(['none', 'quarantine', 'reject']).nullable(),
  organizationalFallback: z.boolean(),
}).superRefine((policy, ctx) => {
  checkPolicyPresence(policy, ctx);
  if (policy.status === 'present' && policy.policy === null) {
    ctx.addIssue({ code: 'custom', path: ['policy'], message: 'A valid DMARC record requires a policy' });
  }
});
export const dkimReportSchema = z.strictObject({
  status: z.enum(['present', 'absent', 'invalid', 'indeterminate', 'not-requested']),
  owner: z.string().min(1).max(253).nullable(),
  selector: z.string().min(1).max(63).nullable(),
  records: policyRecords,
  findings: policyFindings,
}).superRefine((policy, ctx) => {
  checkPolicyPresence(policy, ctx);
  if (policy.status === 'not-requested') {
    if (policy.owner !== null || policy.selector !== null || policy.records.length !== 0) {
      ctx.addIssue({ code: 'custom', message: 'Unrequested DKIM has no owner, selector or records' });
    }
  } else if (policy.owner === null || policy.selector === null) {
    ctx.addIssue({ code: 'custom', message: 'A DKIM observation requires the supplied selector and queried owner' });
  }
});
export const emailPolicyReportSchema = z.strictObject({
  domain: domainSchema,
  organizationalDomain: domainSchema.nullable(),
  resolver: z.string().min(1).max(256),
  spf: spfReportSchema,
  dmarc: dmarcReportSchema,
  dkim: dkimReportSchema,
  evidence: z.array(z.strictObject({
    name: z.string().max(253),
    outcome: dnsOutcomeSchema,
  })).max(LIMITS.emailQueries),
  queriesUsed: z.number().int().min(0).max(LIMITS.emailQueries),
  queryBudget: z.literal(LIMITS.emailQueries),
  limitations: z.array(boundedText(4096)).min(1).max(100),
  evaluationScope: z.literal('dns-records-only'),
  authentication: z.literal('not-verified'),
});
export type EmailPolicyReport = z.infer<typeof emailPolicyReportSchema>;
export type SpfReport = z.infer<typeof spfReportSchema>;
export type DmarcReport = z.infer<typeof dmarcReportSchema>;
export type DkimReport = z.infer<typeof dkimReportSchema>;
export type PolicyFinding = z.infer<typeof policyFindingSchema>;

export const httpHopSchema = z.strictObject({
  url: z.string().max(2048),
  method: z.enum(['HEAD', 'GET']),
  remoteAddress: z.union([ipv4Schema, z.ipv6()]),
  statusCode: z.number().int().min(100).max(599),
  headers: z.array(z.strictObject({
    name: z.string().min(1).max(256),
    value: boundedText(LIMITS.httpHeaderBytes),
  })).max(LIMITS.httpHeaders),
  durationMs: z.number().finite().nonnegative(),
  location: z.string().max(2048).nullable(),
}).refine(({ headers }) => {
  const text = headers.map(({ name, value }) => `${name}: ${value}\r\n`).join('');
  return new TextEncoder().encode(text).byteLength <= LIMITS.httpHeaderBytes;
}, { message: 'Combined headers exceed the per-hop byte budget' });
export const httpReportSchema = z.strictObject({
  requestedUrl: z.string().max(2048),
  method: z.enum(['HEAD', 'GET']),
  hops: z.array(httpHopSchema).max(LIMITS.httpHops),
  termination: z.enum([
    'complete', 'redirect-limit', 'redirect-loop', 'blocked',
    'timeout', 'upstream-error', 'limit-exceeded',
  ]),
});
export type HttpReport = z.infer<typeof httpReportSchema>;
export type HttpHop = z.infer<typeof httpHopSchema>;

export const apiRequestSchemas = {
  dns: dnsRequestSchema,
  emailPolicy: emailPolicyRequestSchema,
  http: httpRequestSchema,
};
export const apiDataSchemas = {
  dns: dnsReportSchema,
  emailPolicy: emailPolicyReportSchema,
  http: httpReportSchema,
};
export const apiResponseSchemas = {
  dns: apiReplySchema(dnsReportSchema),
  emailPolicy: apiReplySchema(emailPolicyReportSchema),
  http: apiReplySchema(httpReportSchema),
};
export type ApiOperation = keyof typeof API_ROUTES;
export type ApiRequest<K extends ApiOperation> = z.input<(typeof apiRequestSchemas)[K]>;
export type ResolvedApiRequest<K extends ApiOperation> = z.output<(typeof apiRequestSchemas)[K]>;
export type ApiData<K extends ApiOperation> = z.output<(typeof apiDataSchemas)[K]>;
export type ApiResponse<K extends ApiOperation> = z.output<(typeof apiResponseSchemas)[K]>;
export type DnsRequest = ApiRequest<'dns'>;
export type EmailPolicyRequest = ApiRequest<'emailPolicy'>;
export type HttpRequest = ApiRequest<'http'>;

export const healthReportSchema = z.strictObject({
  service: z.literal('domos-diagnostics'),
  status: z.enum(['ok', 'not-ready']),
  contractVersion: z.literal(CONTRACT_VERSION),
});
export type HealthReport = z.infer<typeof healthReportSchema>;
