import { z } from 'zod';
import type { LocalToolId } from '@domos/catalog';
import type {
  HashFileOptions, LocalToolInput, LocalToolOutput, LocalToolResult, ResolvedLocalToolInput,
} from './local.js';
import { hashFileOptionsSchema, localInputSchemas, localResultSchemas } from './local.js';
import { LIMITS } from './common.js';

export const progressSchema = z.strictObject({
  phase: z.enum(['reading', 'processing', 'complete']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  unit: z.enum(['bytes', 'items']),
}).refine(({ completed, total }) => completed <= total, {
  message: 'Progress cannot exceed its total',
});
export type ToolProgress = z.infer<typeof progressSchema>;

export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ToolProgress) => void;
}

// These are declarations of the required facade, not placeholder algorithms.
// Validate inputs with localInputSchemas[id] and replies with localResultSchemas[id].
// In browsers, dispatch WORKER_TOOL_IDS and all file hashing to a worker; its
// entry calls handlers directly, not this facade (which would spawn recursively).
export type ExecuteLocalTool = <K extends LocalToolId>(
  id: K,
  input: LocalToolInput<K>,
  context?: ToolExecutionContext,
) => Promise<LocalToolResult<K>>;

export type LocalToolHandler<K extends LocalToolId> = (
  input: ResolvedLocalToolInput<K>,
  context: ToolExecutionContext,
) => Promise<LocalToolResult<K>>;

export type LocalToolHandlers = { [K in LocalToolId]: LocalToolHandler<K> };

// A Blob is passed to the worker, never a fully buffered ArrayBuffer. Enforce
// LIMITS.fileBytes before reading; use incremental LIMITS.hashChunkBytes slices.
export type HashFile = (
  file: Blob,
  options?: HashFileOptions,
  context?: ToolExecutionContext,
) => Promise<LocalToolResult<'sha-checksums'>>;

export const hashFileInputSchema = z.strictObject({
  file: z.instanceof(Blob).refine((file) => file.size <= LIMITS.fileBytes, {
    message: `File must not exceed ${LIMITS.fileBytes} bytes`,
  }),
  options: hashFileOptionsSchema.default({ algorithms: ['SHA-256'] }),
});

export const WORKER_TOOL_IDS = ['regex-tester', 'text-diff', 'sha-checksums'] as const;
export type WorkerToolId = (typeof WORKER_TOOL_IDS)[number];

export type WorkerRunRequest = {
  [K in WorkerToolId]: {
    readonly kind: 'run';
    readonly jobId: string;
    readonly toolId: K;
    readonly input: LocalToolInput<K>;
  };
}[WorkerToolId];

export interface WorkerHashFileRequest {
  readonly kind: 'hash-file';
  readonly jobId: string;
  readonly file: Blob;
  readonly options: HashFileOptions;
}

export type WorkerRequest = WorkerRunRequest | WorkerHashFileRequest;
export type WorkerResponse =
  | { readonly kind: 'progress'; readonly jobId: string; readonly progress: ToolProgress }
  | {
    [K in WorkerToolId]: {
      readonly kind: 'complete';
      readonly jobId: string;
      readonly toolId: K;
      readonly result: LocalToolResult<K>;
    };
  }[WorkerToolId];

const jobIdSchema = z.string().min(1).max(100);
export const workerRequestSchema = z.union([
  z.strictObject({
    kind: z.literal('run'), jobId: jobIdSchema,
    toolId: z.literal('regex-tester'), input: localInputSchemas['regex-tester'],
  }),
  z.strictObject({
    kind: z.literal('run'), jobId: jobIdSchema,
    toolId: z.literal('text-diff'), input: localInputSchemas['text-diff'],
  }),
  z.strictObject({
    kind: z.literal('run'), jobId: jobIdSchema,
    toolId: z.literal('sha-checksums'), input: localInputSchemas['sha-checksums'],
  }),
  z.strictObject({
    kind: z.literal('hash-file'), jobId: jobIdSchema,
    file: hashFileInputSchema.shape.file, options: hashFileOptionsSchema,
  }),
]);
export const workerResponseSchema = z.union([
  z.strictObject({ kind: z.literal('progress'), jobId: jobIdSchema, progress: progressSchema }),
  z.strictObject({
    kind: z.literal('complete'), jobId: jobIdSchema,
    toolId: z.literal('regex-tester'), result: localResultSchemas['regex-tester'],
  }),
  z.strictObject({
    kind: z.literal('complete'), jobId: jobIdSchema,
    toolId: z.literal('text-diff'), result: localResultSchemas['text-diff'],
  }),
  z.strictObject({
    kind: z.literal('complete'), jobId: jobIdSchema,
    toolId: z.literal('sha-checksums'), result: localResultSchemas['sha-checksums'],
  }),
]);

export interface LocalWorkerClient {
  run<K extends WorkerToolId>(
    id: K, input: LocalToolInput<K>, context?: ToolExecutionContext,
  ): Promise<LocalToolResult<K>>;
  hashFile: HashFile;
  dispose(): void;
}

// One active job per worker. Abort, timeout and dispose terminate the worker and
// settle outstanding jobs with ABORTED/TIMEOUT; a stuck regex cannot consume a
// cancel message. Each new job gets a fresh worker. Unexpected faults reject.
export type CreateWorkerClient = (factory?: () => Worker) => LocalWorkerClient;

export type { HashFileOptions, LocalToolInput, LocalToolOutput, LocalToolResult, LocalToolId };
