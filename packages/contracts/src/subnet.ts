import { z } from 'zod';
import { boundedText, downloadSchema, jsonWithinByteLimit, LIMITS } from './common.js';

const octet = '(?:0|[1-9]\\d?|1\\d{2}|2[0-4]\\d|25[0-5])';
export const ipv4Schema = z.string().regex(new RegExp(`^(?:${octet}\\.){3}${octet}$`));
export const ipv4CidrSchema = z.string().regex(
  new RegExp(`^(?:${octet}\\.){3}${octet}/(?:[0-9]|[12][0-9]|3[0-2])$`),
);
export const subnetColorSchema = z.enum(['slate', 'teal', 'blue', 'amber', 'rose', 'violet']);
export const subnetAnnotationSchema = z.strictObject({
  note: boundedText(1024).default(''),
  color: subnetColorSchema.default('teal'),
});
export const subnetAllocationSchema = z.strictObject({
  cidr: ipv4CidrSchema,
  note: boundedText(1024),
  color: subnetColorSchema,
});

// The core validates canonical, disjoint leaves that exactly partition rootCidr
// on every command, including import. Schema validity alone is not allocation validity.
export const subnetStateSchema = z.strictObject({
  version: z.literal(1),
  rootCidr: ipv4CidrSchema,
  allocations: z.array(subnetAllocationSchema).min(1).max(LIMITS.subnetLeaves),
}).refine((state) => jsonWithinByteLimit(state, LIMITS.outputBytes), {
  message: 'Subnet state exceeds the import/export byte budget',
});
export type SubnetState = z.infer<typeof subnetStateSchema>;
export type SubnetAllocation = z.infer<typeof subnetAllocationSchema>;
export type SubnetAnnotation = z.infer<typeof subnetAnnotationSchema>;

export const subnetInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    cidr: ipv4CidrSchema,
    annotation: subnetAnnotationSchema.default({ note: '', color: 'teal' }),
  }),
  z.strictObject({ action: z.literal('split'), state: subnetStateSchema, cidr: ipv4CidrSchema }),
  z.strictObject({
    action: z.literal('join'),
    state: subnetStateSchema,
    cidrs: z.tuple([ipv4CidrSchema, ipv4CidrSchema]),
    // Required by the core when sibling annotations differ; never discard silently.
    annotation: subnetAnnotationSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('annotate'),
    state: subnetStateSchema,
    cidr: ipv4CidrSchema,
    annotation: subnetAnnotationSchema,
  }),
  z.strictObject({ action: z.literal('import'), json: boundedText(LIMITS.outputBytes) }),
  z.strictObject({
    action: z.literal('export'),
    state: subnetStateSchema,
    format: z.enum(['json', 'csv']),
  }),
]);

const addressCountSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
export const subnetRowSchema = z.strictObject({
  cidr: ipv4CidrSchema,
  prefix: z.number().int().min(0).max(32),
  network: ipv4Schema,
  broadcast: ipv4Schema.nullable(),
  firstAddress: ipv4Schema,
  lastAddress: ipv4Schema,
  firstUsable: ipv4Schema,
  lastUsable: ipv4Schema,
  totalAddresses: addressCountSchema,
  usableHosts: addressCountSchema,
  semantics: z.enum(['subnet', 'point-to-point', 'host']),
  note: boundedText(1024),
  color: subnetColorSchema,
});
export const subnetOutputSchema = z.strictObject({
  state: subnetStateSchema,
  rows: z.array(subnetRowSchema).min(1).max(LIMITS.subnetLeaves),
  download: downloadSchema.optional(),
});
export type SubnetInput = z.input<typeof subnetInputSchema>;
export type SubnetOutput = z.infer<typeof subnetOutputSchema>;
export type SubnetRow = z.infer<typeof subnetRowSchema>;
