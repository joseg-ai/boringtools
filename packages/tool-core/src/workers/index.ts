import {
  LIMITS, hashFileInputSchema, localInputSchemas, localResultSchemas,
  workerResponseSchema,
  type CreateWorkerClient, type HashFile, type LocalToolInput, type LocalToolResult,
  type ToolExecutionContext, type WorkerRequest,
  type WorkerToolId,
} from '@domos/contracts';
import { errorResult, faultResult, validationFault } from '../errors.js';

export { WORKER_TOOL_IDS } from '@domos/contracts';
export type { CreateWorkerClient, LocalWorkerClient, WorkerToolId } from '@domos/contracts';

const budgets: Record<WorkerToolId, number> = {
  'regex-tester': LIMITS.regexTimeoutMs,
  'text-diff': LIMITS.diffTimeoutMs,
  'sha-checksums': LIMITS.hashTimeoutMs,
};

const resultParsers: {
  [K in WorkerToolId]: (value: unknown) => LocalToolResult<K>;
} = {
  'regex-tester': (value) => localResultSchemas['regex-tester'].parse(value),
  'text-diff': (value) => localResultSchemas['text-diff'].parse(value),
  'sha-checksums': (value) => localResultSchemas['sha-checksums'].parse(value),
};

function defaultFactory(): Worker {
  return new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
}

export const createWorkerClient: CreateWorkerClient = (factory = defaultFactory) => {
  let disposed = false;
  let sequence = 0;
  const active = new Set<() => void>();
  const allocated = new WeakSet<Worker>();

  function dispatch<K extends WorkerToolId>(
    id: K, request: WorkerRequest, context: ToolExecutionContext = {},
  ): Promise<LocalToolResult<K>> {
    const parseResult = resultParsers[id];
    if (disposed || context.signal?.aborted) {
      return Promise.resolve(parseResult(errorResult('ABORTED', disposed ? 'Worker client is disposed.' : 'Operation cancelled.')));
    }
    if (factory === defaultFactory && typeof Worker === 'undefined') {
      return Promise.resolve(parseResult(errorResult('UNSUPPORTED', 'This browser does not support Web Workers.')));
    }
    return new Promise((resolve, reject) => {
      const worker = factory();
      if (allocated.has(worker)) throw new Error('Worker factory must create a fresh worker for each job.');
      allocated.add(worker);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let progressCompleted = 0;
      let progressTotal: number | undefined;
      let progressUnit: string | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        worker.removeEventListener('message', message);
        worker.removeEventListener('error', failure);
        worker.removeEventListener('messageerror', messageFailure);
        worker.terminate();
        active.delete(abort);
      };
      const finish = (value: unknown, error = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(value);
        else {
          try { resolve(parseResult(value)); } catch (fault) { reject(fault); }
        }
      };
      const abort = () => finish(errorResult('ABORTED', disposed ? 'Worker client was disposed.' : 'Operation cancelled.'));
      const failure = (event: ErrorEvent) => {
        event.preventDefault();
        finish(event.error ?? new Error(event.message || 'Worker execution failed.'), true);
      };
      const messageFailure = () => finish(new Error('Worker response could not be deserialized.'), true);
      const message = (event: MessageEvent<unknown>) => {
        const parsed = workerResponseSchema.safeParse(event.data);
        if (!parsed.success) { finish(new Error('Worker returned an invalid response.'), true); return; }
        const response = parsed.data;
        if (response.jobId !== request.jobId) { finish(new Error('Worker returned the wrong job identifier.'), true); return; }
        if (response.kind === 'progress') {
          const progress = response.progress;
          if ((progressTotal !== undefined && progress.total !== progressTotal)
            || (progressUnit !== undefined && progress.unit !== progressUnit)
            || progress.completed < progressCompleted
            || (request.kind === 'hash-file' && (progress.unit !== 'bytes' || progress.total !== request.file.size))) {
            finish(new Error('Worker progress is inconsistent with its job.'), true);
            return;
          }
          progressCompleted = progress.completed;
          progressTotal = progress.total;
          progressUnit = progress.unit;
          try { context.onProgress?.(progress); } catch (error) { finish(error, true); }
        } else if (response.toolId !== id) {
          finish(new Error('Worker returned a result for the wrong tool.'), true);
        } else {
          if (response.toolId === 'sha-checksums' && response.result.kind === 'result') {
            const data = response.result.data;
            if ((request.kind === 'hash-file' && (data.source !== 'file' || data.byteLength !== request.file.size
              || data.fileName !== request.options.fileName))
              || (request.kind === 'run' && data.source !== 'text')) {
              finish(new Error('Worker hash result does not match its input source.'), true);
              return;
            }
            if (request.kind === 'hash-file' || request.toolId === 'sha-checksums') {
              const algorithms = request.kind === 'hash-file' ? request.options.algorithms : request.input.algorithms;
              if (data.hashes.map((hash) => hash.algorithm).join(',') !== (algorithms ?? ['SHA-256']).join(',')) {
                finish(new Error('Worker hash algorithms do not match the request.'), true);
                return;
              }
            }
          }
          finish(response.result);
        }
      };
      active.add(abort);
      worker.addEventListener('message', message);
      worker.addEventListener('error', failure);
      worker.addEventListener('messageerror', messageFailure);
      context.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(errorResult('TIMEOUT', `Worker exceeded its ${budgets[id]} ms execution budget.`)), budgets[id]);
      if (context.signal?.aborted || disposed) { abort(); return; }
      try { worker.postMessage(request); } catch (error) { finish(error, true); }
    });
  }

  type RunFunctions = {
    [K in WorkerToolId]: (
      input: LocalToolInput<K>, context?: ToolExecutionContext,
    ) => Promise<LocalToolResult<K>>;
  };
  const runFunctions: RunFunctions = {
    'regex-tester': (input, context) => {
      const parsed = localInputSchemas['regex-tester'].safeParse(input);
      if (!parsed.success) return Promise.resolve(faultResult(validationFault(parsed.error.issues)));
      return dispatch('regex-tester', { kind: 'run', jobId: String(++sequence), toolId: 'regex-tester', input: parsed.data }, context);
    },
    'text-diff': (input, context) => {
      const parsed = localInputSchemas['text-diff'].safeParse(input);
      if (!parsed.success) return Promise.resolve(faultResult(validationFault(parsed.error.issues)));
      return dispatch('text-diff', { kind: 'run', jobId: String(++sequence), toolId: 'text-diff', input: parsed.data }, context);
    },
    'sha-checksums': (input, context) => {
      const parsed = localInputSchemas['sha-checksums'].safeParse(input);
      if (!parsed.success) return Promise.resolve(faultResult(validationFault(parsed.error.issues)));
      return dispatch('sha-checksums', { kind: 'run', jobId: String(++sequence), toolId: 'sha-checksums', input: parsed.data }, context);
    },
  };
  const hashFile: HashFile = (file, options, context) => {
    const parsed = hashFileInputSchema.safeParse({ file, options });
    if (!parsed.success) return Promise.resolve(faultResult(validationFault(parsed.error.issues)));
    return dispatch('sha-checksums', {
      kind: 'hash-file', jobId: String(++sequence), file: parsed.data.file, options: parsed.data.options,
    }, context);
  };
  return {
    run<K extends WorkerToolId>(id: K, input: LocalToolInput<K>, context?: ToolExecutionContext) {
      return runFunctions[id](input, context);
    },
    hashFile,
    dispose() {
      disposed = true;
      for (const abort of [...active]) abort();
    },
  };
};
