import { API_ROUTES, API_ERROR_HTTP_STATUS, LIMITS, apiRequestSchemas, apiResponseSchemas, type ApiOperation, type ApiRequest, type ApiResponse } from '@domos/contracts';
import { API_ORIGIN } from '../config';

// Scale-to-zero activation is separate from the API's bounded inspection time.
export const SERVICE_ACTIVATION_ALLOWANCE_MS = 45_000;

export class RequestFailure extends Error {}
export function requestLive(operation: 'dns', input: ApiRequest<'dns'>, signal: AbortSignal): Promise<ApiResponse<'dns'>>;
export function requestLive(operation: 'emailPolicy', input: ApiRequest<'emailPolicy'>, signal: AbortSignal): Promise<ApiResponse<'emailPolicy'>>;
export function requestLive(operation: 'http', input: ApiRequest<'http'>, signal: AbortSignal): Promise<ApiResponse<'http'>>;
export async function requestLive(operation: ApiOperation, input: ApiRequest<ApiOperation>, signal: AbortSignal): Promise<ApiResponse<ApiOperation>> {
  const request = apiRequestSchemas[operation].safeParse(input);
  if (!request.success) throw new RequestFailure(request.error.issues.map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('\n'));
  const body = JSON.stringify(request.data);
  if (new TextEncoder().encode(body).byteLength > LIMITS.apiBodyBytes) throw new RequestFailure('Request exceeds the API input limit.');
  const response = await fetch(`${API_ORIGIN}${API_ROUTES[operation]}`, {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body, signal,
  });
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new RequestFailure(`API returned HTTP ${response.status} without a JSON report.`);
  const length = response.headers.get('content-length');
  if (length && Number(length) > LIMITS.apiResponseBytes) { await response.body?.cancel(); throw new RequestFailure('API response exceeds the allowed size.'); }
  if (!response.body) throw new RequestFailure('API returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = ''; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMITS.apiResponseBytes) { await reader.cancel(); throw new RequestFailure('API response exceeds the allowed size.'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new RequestFailure('API returned malformed JSON. No report was accepted.'); }
  const report = apiResponseSchemas[operation].safeParse(raw);
  if (!report.success) throw new RequestFailure('API response did not match the report contract. No report was accepted.');
  const expectedStatus = report.data.kind === 'error' ? API_ERROR_HTTP_STATUS[report.data.error.code] : 200;
  if (response.status !== expectedStatus) throw new RequestFailure(`API report disagrees with HTTP status ${response.status}. No report was accepted.`);
  return report.data;
}
