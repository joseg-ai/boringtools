import { z } from 'zod';

export const CONTRACT_VERSION = 1 as const;
export const LIMITS = Object.freeze({
  textBytes: 1_048_576,
  outputBytes: 2_097_152,
  subnetLeaves: 4096,
  fileBytes: 250 * 1024 * 1024,
  hashChunkBytes: 1024 * 1024,
  regexPatternBytes: 8192,
  regexTextBytes: 200 * 1024,
  regexMatches: 1000,
  regexTimeoutMs: 1000,
  diffSideBytes: 512 * 1024,
  diffParts: 10_000,
  diffTimeoutMs: 2000,
  hashTimeoutMs: 120_000,
  apiBodyBytes: 16 * 1024,
  apiResponseBytes: 256 * 1024,
  dnsQueries: 16,
  emailQueries: 32,
  emailDepth: 5,
  httpRedirects: 5,
  httpHops: 6,
  httpHeaderBytes: 16 * 1024,
  httpHeaders: 100,
  httpAddresses: 16,
  dnsTimeoutMs: 8000,
  emailTimeoutMs: 10_000,
  httpTimeoutMs: 12_000,
});

export function boundedText(maxBytes: number = LIMITS.textBytes) {
  return z.string().max(maxBytes).refine(
    (text) => new TextEncoder().encode(text).byteLength <= maxBytes,
    { message: `Text must not exceed ${maxBytes} UTF-8 bytes` },
  );
}

export function jsonWithinByteLimit(value: unknown, maxBytes: number): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
}

export const instantSchema = z.iso.datetime({ offset: true });
export const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}, { message: 'Use a supported IANA timezone, for example UTC or America/New_York' });

export const noticeSchema = z.strictObject({
  level: z.enum(['info', 'warning']),
  code: z.string().min(1).max(80),
  text: boundedText(4096),
});
export type Notice = z.infer<typeof noticeSchema>;

export const inputIssueSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(64),
  message: boundedText(4096),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});

export const localErrorSchema = z.strictObject({
  code: z.enum(['INVALID_INPUT', 'LIMIT_EXCEEDED', 'TIMEOUT', 'ABORTED', 'UNSUPPORTED']),
  message: boundedText(4096),
  issues: z.array(inputIssueSchema).max(100).default([]),
});
export type LocalToolError = z.infer<typeof localErrorSchema>;

export function localResultSchema<S extends z.ZodType>(data: S) {
  return z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('result'),
      data,
      notices: z.array(noticeSchema).max(100),
    }),
    z.strictObject({ kind: z.literal('error'), error: localErrorSchema }),
  ]).refine((value) => jsonWithinByteLimit(value, LIMITS.outputBytes), {
    message: `Serialized local result must not exceed ${LIMITS.outputBytes} bytes`,
  });
}

export const downloadSchema = z.strictObject({
  filename: z.string().min(1).max(255),
  mime: z.enum(['application/json', 'text/csv', 'text/plain']),
  text: boundedText(LIMITS.outputBytes),
});
export type TextDownload = z.infer<typeof downloadSchema>;
