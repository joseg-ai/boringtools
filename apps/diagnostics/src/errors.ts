import type { ApiError, ApiErrorCode } from '@domos/contracts';

const messages: Record<ApiErrorCode, string> = {
  INVALID_INPUT: 'The request does not match the supported input schema.',
  TARGET_BLOCKED: 'The target is outside the public diagnostics policy.',
  RATE_LIMITED: 'Service capacity is temporarily exhausted. Retry later.',
  UPSTREAM_ERROR: 'The upstream service did not provide a usable response.',
  TIMEOUT: 'The diagnostics deadline was exceeded.',
  LIMIT_EXCEEDED: 'A diagnostics resource limit was exceeded.',
  NOT_READY: 'The service is not ready.',
  NOT_FOUND: 'The requested route does not exist.',
  METHOD_NOT_ALLOWED: 'The method is not supported for this route.',
  UNSUPPORTED_MEDIA_TYPE: 'Use application/json with UTF-8 encoding.',
  INTERNAL_ERROR: 'The service could not complete this request.',
};

export class DiagnosticError extends Error {
  readonly detail: ApiError;

  constructor(code: ApiErrorCode, phase: ApiError['phase']) {
    super(messages[code]);
    this.detail = {
      code, phase, message: messages[code],
      ...(code === 'RATE_LIMITED' ? { retryAfterSeconds: 60 } : {}),
    };
  }
}

export function failure(code: ApiErrorCode, phase: ApiError['phase']): ApiError {
  return new DiagnosticError(code, phase).detail;
}

export function safeError(error: unknown, phase: ApiError['phase'], signal?: AbortSignal): ApiError {
  if (signal?.aborted) return failure('TIMEOUT', phase);
  if (error instanceof DiagnosticError) return error.detail;
  return failure(phase === 'service' ? 'INTERNAL_ERROR' : 'UPSTREAM_ERROR', phase);
}

export function checkAbort(signal: AbortSignal, phase: ApiError['phase']): void {
  if (signal.aborted) throw new DiagnosticError('TIMEOUT', phase);
}

export interface Observation<T> {
  data: T;
  error?: ApiError;
}
