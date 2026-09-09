import { LIMITS, type LocalToolError, type ToolExecutionContext } from '@domos/contracts';

export class InputFault extends Error {
  constructor(
    readonly code: LocalToolError['code'],
    message: string,
    readonly issues: LocalToolError['issues'] = [],
  ) {
    super(message);
    this.name = 'InputFault';
  }
}

export function invalid(message: string): never {
  throw new InputFault('INVALID_INPUT', message);
}

export function unsupported(message: string): never {
  throw new InputFault('UNSUPPORTED', message);
}

export function limit(message: string): never {
  throw new InputFault('LIMIT_EXCEEDED', message);
}

export function checkAbort(context: ToolExecutionContext): void {
  if (context.signal?.aborted) throw new InputFault('ABORTED', 'Operation cancelled.');
}

export function errorResult(code: LocalToolError['code'], message: string) {
  return { kind: 'error' as const, error: { code, message, issues: [] } };
}

export function faultResult(fault: InputFault) {
  return {
    kind: 'error' as const,
    error: { code: fault.code, message: fault.message, issues: fault.issues },
  };
}

export interface ValidationIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
}

export function validationFault(issues: readonly ValidationIssue[]): InputFault {
  return new InputFault(
    issues.some((issue) => issue.code === 'too_big' || /bytes|exceed/i.test(issue.message))
      ? 'LIMIT_EXCEEDED' : 'INVALID_INPUT',
    'Input does not match the tool contract.',
    issues.slice(0, 100).map((issue) => ({
      path: issue.path.slice(0, 64).map((key) => typeof key === 'symbol' ? String(key) : key),
      message: issue.message.slice(0, 1000),
    })),
  );
}

export function checkOutputSize(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).length > LIMITS.outputBytes) {
    limit(`Result exceeds the ${LIMITS.outputBytes}-byte output budget.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
