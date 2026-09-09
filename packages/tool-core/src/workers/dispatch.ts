import { workerRequestSchema, workerResponseSchema, type WorkerResponse, type ToolProgress } from '@domos/contracts';
import { faultResult, isRecord, validationFault } from '../errors.js';
import { executeDirect, hashFileLocally } from '../runtime.js';

export async function dispatchWorkerRequest(
  value: unknown, post: (response: WorkerResponse) => void,
): Promise<void> {
  const parsed = workerRequestSchema.safeParse(value);
  if (!parsed.success) {
    if (isRecord(value) && typeof value.jobId === 'string' && value.jobId.length > 0 && value.jobId.length <= 100) {
      const result = faultResult(validationFault(parsed.error.issues));
      if (value.kind === 'hash-file' && Object.keys(value).every((key) => ['kind', 'jobId', 'file', 'options'].includes(key))) {
        post({ kind: 'complete', jobId: value.jobId, toolId: 'sha-checksums', result });
        return;
      }
      if (value.kind === 'run' && Object.keys(value).every((key) => ['kind', 'jobId', 'toolId', 'input'].includes(key))
        && (value.toolId === 'regex-tester' || value.toolId === 'text-diff' || value.toolId === 'sha-checksums')) {
        post({ kind: 'complete', jobId: value.jobId, toolId: value.toolId, result });
        return;
      }
    }
    // An invalid envelope cannot identify a safe job to settle.
    throw new Error('Invalid worker request.');
  }
  const request = parsed.data;
  const context = {
    onProgress(progress: ToolProgress) {
      post(workerResponseSchema.parse({ kind: 'progress', jobId: request.jobId, progress }));
    },
  };
  if (request.kind === 'hash-file') {
    const result = await hashFileLocally(request.file, request.options, context);
    post(workerResponseSchema.parse({ kind: 'complete', jobId: request.jobId, toolId: 'sha-checksums', result }));
    return;
  }
  switch (request.toolId) {
    case 'regex-tester': {
      const result = await executeDirect(request.toolId, request.input, context);
      post({ kind: 'complete', jobId: request.jobId, toolId: request.toolId, result });
      break;
    }
    case 'text-diff': {
      const result = await executeDirect(request.toolId, request.input, context);
      post({ kind: 'complete', jobId: request.jobId, toolId: request.toolId, result });
      break;
    }
    case 'sha-checksums': {
      const result = await executeDirect(request.toolId, request.input, context);
      post({ kind: 'complete', jobId: request.jobId, toolId: request.toolId, result });
      break;
    }
  }
}
