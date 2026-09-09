import type {
  HashFile, LocalToolId, LocalToolInput, LocalToolResult, ToolExecutionContext,
} from '@domos/contracts';
import { directExecutors, hashFileLocally } from './runtime.js';
import { createWorkerClient } from './workers/index.js';

const browserWorkers = createWorkerClient();
type Executors = {
  [K in LocalToolId]: (
    input: LocalToolInput<K>, context?: ToolExecutionContext,
  ) => Promise<LocalToolResult<K>>;
};
const browserExecutors: Executors = {
  ...directExecutors,
  'regex-tester': (input, context) => browserWorkers.run('regex-tester', input, context),
  'text-diff': (input, context) => browserWorkers.run('text-diff', input, context),
  'sha-checksums': (input, context) => browserWorkers.run('sha-checksums', input, context),
};

export function executeLocalTool<K extends LocalToolId>(
  id: K, input: LocalToolInput<K>, context?: ToolExecutionContext,
): Promise<LocalToolResult<K>> {
  const executors = typeof window !== 'undefined' ? browserExecutors : directExecutors;
  return executors[id](input, context);
}

export const hashFile: HashFile = (file, options, context) =>
  typeof window !== 'undefined'
    ? browserWorkers.hashFile(file, options, context)
    : hashFileLocally(file, options, context);

export { createWorkerClient };
export type {
  ExecuteLocalTool,
  HashFile,
  CreateWorkerClient,
  LocalToolHandlers,
  LocalToolInput,
  LocalToolOutput,
  LocalToolResult,
  ToolExecutionContext,
  HashFileOptions,
  LocalWorkerClient,
  LocalToolId,
} from '@domos/contracts';
