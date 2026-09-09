import {
  hashFileInputSchema, localInputSchemas, localResultSchemas,
  type HashFile, type LocalToolHandler, type LocalToolHandlers, type LocalToolId,
  type LocalToolInput, type LocalToolResult, type ToolExecutionContext,
} from '@domos/contracts';
import { base64, jwt, url } from './encoding.js';
import { chmod } from './chmod.js';
import { diff, hashFileDirect, regex, sha } from './compute.js';
import { email } from './email.js';
import { password } from './password.js';
import { structured } from './structured.js';
import { subnet } from './subnet.js';
import { cron, epoch } from './time.js';
import { checkAbort, checkOutputSize, faultResult, InputFault, validationFault, type ValidationIssue } from './errors.js';

export interface Schema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly ValidationIssue[] } };
}

export function validated<I, R>(
  inputSchema: Schema<I>, resultSchema: Schema<R>,
  handler: (input: NoInfer<I>, context: ToolExecutionContext) => Promise<NoInfer<R>>,
): (input: unknown, context?: ToolExecutionContext) => Promise<R> {
  return async (input, context = {}) => {
    let result: R;
    try {
      checkAbort(context);
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw validationFault(parsed.error.issues);
      result = await handler(parsed.data, context);
      checkAbort(context);
      checkOutputSize(result);
    } catch (error) {
      if (!(error instanceof InputFault)) throw error;
      return resultSchema.parse(faultResult(error));
    }
    // A malformed handler result is a programming fault, not invalid input.
    return resultSchema.parse(result);
  };
}

export const handlers: LocalToolHandlers = {
  'ipv4-subnet-planner': subnet,
  'email-header-analyzer': email,
  chmod,
  'password-generator': password,
  'json-yaml-workbench': structured,
  base64,
  'url-workbench': url,
  'jwt-decoder': jwt,
  'sha-checksums': sha,
  'regex-tester': regex,
  'text-diff': diff,
  'cron-helper': cron,
  'epoch-time': epoch,
};

type Executors = {
  [K in LocalToolId]: (
    input: LocalToolInput<K>, context?: ToolExecutionContext,
  ) => Promise<LocalToolResult<K>>;
};

export const directExecutors: Executors = {
  'ipv4-subnet-planner': validated(localInputSchemas['ipv4-subnet-planner'], localResultSchemas['ipv4-subnet-planner'], subnet),
  'email-header-analyzer': validated(localInputSchemas['email-header-analyzer'], localResultSchemas['email-header-analyzer'], email),
  chmod: validated(localInputSchemas.chmod, localResultSchemas.chmod, chmod),
  'password-generator': validated(localInputSchemas['password-generator'], localResultSchemas['password-generator'], password),
  'json-yaml-workbench': validated(localInputSchemas['json-yaml-workbench'], localResultSchemas['json-yaml-workbench'], structured),
  base64: validated(localInputSchemas.base64, localResultSchemas.base64, base64),
  'url-workbench': validated(localInputSchemas['url-workbench'], localResultSchemas['url-workbench'], url),
  'jwt-decoder': validated(localInputSchemas['jwt-decoder'], localResultSchemas['jwt-decoder'], jwt),
  'sha-checksums': validated(localInputSchemas['sha-checksums'], localResultSchemas['sha-checksums'], sha),
  'regex-tester': validated(localInputSchemas['regex-tester'], localResultSchemas['regex-tester'], regex),
  'text-diff': validated(localInputSchemas['text-diff'], localResultSchemas['text-diff'], diff),
  'cron-helper': validated(localInputSchemas['cron-helper'], localResultSchemas['cron-helper'], cron),
  'epoch-time': validated(localInputSchemas['epoch-time'], localResultSchemas['epoch-time'], epoch),
};

const validatedHashFile = validated(
  hashFileInputSchema, localResultSchemas['sha-checksums'],
  ({ file, options }, context) => hashFileDirect(file, options, context),
);

export const hashFileLocally: HashFile = (file, options, context) =>
  validatedHashFile({ file, options }, context);

export function executeDirect<K extends LocalToolId>(
  id: K, input: LocalToolInput<K>, context?: ToolExecutionContext,
): Promise<LocalToolResult<K>> {
  return directExecutors[id](input, context);
}

export type { LocalToolHandler };
