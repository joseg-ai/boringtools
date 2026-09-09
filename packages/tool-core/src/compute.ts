import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { createTwoFilesPatch, diffLines, diffWords, diffWordsWithSpace } from 'diff';
import {
  LIMITS, type HashAlgorithm, type HashFileOptions, type LocalToolHandler,
  type LocalToolOutput, type LocalToolResult, type ToolExecutionContext,
} from '@domos/contracts';
import { bytesToHex, readBytes } from './bytes.js';
import { checkAbort, checkOutputSize, InputFault, invalid, limit } from './errors.js';

const hashFunctions = { 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 };

export const sha: LocalToolHandler<'sha-checksums'> = async (input, context) => {
  checkAbort(context);
  const bytes = readBytes(input.text, input.inputEncoding);
  const hashes = input.algorithms.map((algorithm) => ({
    algorithm, digest: bytesToHex(hashFunctions[algorithm](bytes)),
  }));
  return { kind: 'result', notices: [], data: { source: 'text', byteLength: bytes.length, hashes } };
};

export async function hashFileDirect(
  file: Blob, options: HashFileOptions, context: ToolExecutionContext,
): Promise<LocalToolResult<'sha-checksums'>> {
  checkAbort(context);
  if (file.size > LIMITS.fileBytes) limit('Files cannot exceed 250 MiB.');
  const algorithms: HashAlgorithm[] = options.algorithms ?? ['SHA-256'];
  const hashers = algorithms.map((algorithm) => ({ algorithm, state: hashFunctions[algorithm].create() }));
  const report = (phase: 'reading' | 'processing' | 'complete', completed: number) => {
    context.onProgress?.({ phase, completed, total: file.size, unit: 'bytes' });
  };
  try {
    report('reading', 0);
    for (let offset = 0; offset < file.size; offset += LIMITS.hashChunkBytes) {
      checkAbort(context);
      const end = Math.min(offset + LIMITS.hashChunkBytes, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      checkAbort(context);
      if (bytes.length !== end - offset) throw new Error('Blob returned an unexpected chunk length.');
      for (const hasher of hashers) hasher.state.update(bytes);
      report('processing', end);
    }
    checkAbort(context);
    const hashes = hashers.map(({ algorithm, state }) => ({ algorithm, digest: bytesToHex(state.digest()) }));
    report('complete', file.size);
    checkAbort(context);
    return {
      kind: 'result', notices: [], data: {
        source: 'file', byteLength: file.size, hashes,
        ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
      },
    };
  } finally {
    for (const hasher of hashers) hasher.state.destroy();
  }
}

export const regex: LocalToolHandler<'regex-tester'> = async (input, context) => {
  checkAbort(context);
  let expression: RegExp;
  try {
    expression = new RegExp(input.pattern, input.flags);
  } catch (error) {
    if (error instanceof SyntaxError) invalid(error.message.slice(0, 1000));
    throw error;
  }
  const matches: LocalToolOutput<'regex-tester'>['matches'] = [];
  let truncated = false;
  const start = performance.now();
  let outputBytes = 0;
  while (true) {
    checkAbort(context);
    // This cooperative check complements, never replaces, browser worker
    // termination: a single catastrophic exec cannot reach this check.
    if (performance.now() - start > LIMITS.regexTimeoutMs) throw new InputFault('TIMEOUT', 'Regex exceeded its one-second budget.');
    const match = expression.exec(input.text);
    if (!match) break;
    if (matches.length === input.maxMatches) { truncated = true; break; }
    if (match.length - 1 > 1000) limit('Regex captures exceed the 1,000-group limit.');
    const record = {
      index: match.index, text: match[0],
      groups: match.slice(1).map((value) => value ?? null),
      namedGroups: Object.fromEntries(Object.entries(match.groups ?? {}).map(([key, value]) => [key, value ?? null])),
    };
    outputBytes += new TextEncoder().encode(JSON.stringify(record)).length;
    if (outputBytes > LIMITS.outputBytes) limit('Regex captures exceed the output budget.');
    matches.push(record);
    if (!expression.global && !expression.sticky) break;
    if (!match[0].length) {
      const index = expression.lastIndex;
      const code = input.text.codePointAt(index);
      expression.lastIndex += (input.flags.includes('u') || input.flags.includes('v')) && code !== undefined && code > 0xffff ? 2 : 1;
    }
  }
  return { kind: 'result', notices: [], data: { matches, truncated, flags: input.flags } };
};

export const diff: LocalToolHandler<'text-diff'> = async (input, context) => {
  checkAbort(context);
  const started = performance.now();
  const options = { timeout: LIMITS.diffTimeoutMs, maxEditLength: LIMITS.diffParts, ignoreWhitespace: input.ignoreWhitespace };
  const changes = input.mode === 'line' ? diffLines(input.before, input.after, options)
    : input.ignoreWhitespace ? diffWords(input.before, input.after, options)
      : diffWordsWithSpace(input.before, input.after, options);
  if (!changes) throw new InputFault('LIMIT_EXCEEDED', 'Diff exceeded its time or edit-distance budget.');
  if (changes.length > LIMITS.diffParts) limit('Diff exceeds 10,000 parts.');
  const parts: LocalToolOutput<'text-diff'>['parts'] = changes.map((change) => ({
    kind: change.added ? 'added' : change.removed ? 'removed' : 'equal',
    text: change.value, count: change.count,
  }));
  checkAbort(context);
  const remaining = LIMITS.diffTimeoutMs - (performance.now() - started);
  if (remaining <= 0) throw new InputFault('TIMEOUT', 'Diff exceeded its two-second budget.');
  const unified = createTwoFilesPatch('before', 'after', input.before, input.after, undefined, undefined, {
    context: input.contextLines, ignoreWhitespace: input.ignoreWhitespace,
    timeout: remaining, maxEditLength: LIMITS.diffParts,
  });
  if (unified === undefined) throw new InputFault('LIMIT_EXCEEDED', 'Unified diff exceeded its time or edit-distance budget.');
  const stats = { added: 0, removed: 0, unchanged: 0 };
  for (const part of parts) stats[part.kind === 'equal' ? 'unchanged' : part.kind] += part.count;
  const data = { parts, unified, stats };
  checkOutputSize(data);
  return { kind: 'result', notices: [], data };
};
