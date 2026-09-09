import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, workerRequestSchema, type WorkerRequest, type WorkerResponse } from '@domos/contracts';
import { createWorkerClient } from './index.js';
import { dispatchWorkerRequest } from './dispatch.js';
import { executeLocalTool, hashFile } from '../index.js';

class MockWorker extends EventTarget implements Worker {
  onmessage: Worker['onmessage'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  onerror: Worker['onerror'] = null;
  readonly terminate = vi.fn();
  readonly sent: WorkerRequest[] = [];
  postMessage(value: unknown) {
    this.sent.push(workerRequestSchema.parse(value));
  }
  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }
  error(message: string) {
    const event = new Event('error', { cancelable: true });
    Object.defineProperty(event, 'message', { value: message });
    this.dispatchEvent(event);
  }
}

function setup() {
  const workers: MockWorker[] = [];
  const factory = () => {
    const worker = new MockWorker();
    workers.push(worker);
    return worker;
  };
  return { workers, client: createWorkerClient(factory) };
}

function regexResponse(worker: MockWorker): WorkerResponse {
  return {
    kind: 'complete', jobId: worker.sent[0]!.jobId, toolId: 'regex-tester',
    result: { kind: 'result', notices: [], data: { matches: [], truncated: false, flags: 'g' } },
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('disposable browser worker client', () => {
  it('validates replies and terminates each successful worker', async () => {
    const { client, workers } = setup();
    const result = client.run('regex-tester', { pattern: 'x', text: '' });
    workers[0]!.receive(regexResponse(workers[0]!));
    expect(await result).toMatchObject({ kind: 'result', data: { matches: [] } });
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    const second = client.run('regex-tester', { pattern: 'x', text: '' });
    expect(workers).toHaveLength(2);
    workers[1]!.receive(regexResponse(workers[1]!));
    await second;
    client.dispose();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });
  it('rejects factories that reuse a terminated worker', async () => {
    const worker = new MockWorker();
    const client = createWorkerClient(() => worker);
    const result = client.run('regex-tester', { pattern: '', text: '' });
    worker.receive(regexResponse(worker));
    await result;
    await expect(client.run('regex-tester', { pattern: '', text: '' })).rejects.toThrow('fresh worker');
  });

  it('terminates blocked regex, diff and hash jobs at their budgets', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup();
    const regex = client.run('regex-tester', { pattern: '(a+)+$', text: 'a'.repeat(100) + '!' });
    const diff = client.run('text-diff', { before: 'a', after: 'b' });
    const sha = client.run('sha-checksums', { text: 'abc' });
    await vi.advanceTimersByTimeAsync(LIMITS.regexTimeoutMs);
    expect(await regex).toMatchObject({ kind: 'error', error: { code: 'TIMEOUT' } });
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(workers[1]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIMITS.diffTimeoutMs - LIMITS.regexTimeoutMs);
    expect(await diff).toMatchObject({ kind: 'error', error: { code: 'TIMEOUT' } });
    await vi.advanceTimersByTimeAsync(LIMITS.hashTimeoutMs - LIMITS.diffTimeoutMs);
    expect(await sha).toMatchObject({ kind: 'error', error: { code: 'TIMEOUT' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles every active job on abort or disposal and never reuses a worker', async () => {
    const { client, workers } = setup();
    const controller = new AbortController();
    const first = client.run('regex-tester', { pattern: '', text: '' }, { signal: controller.signal });
    controller.abort();
    expect(await first).toMatchObject({ kind: 'error', error: { code: 'ABORTED' } });
    const second = client.run('text-diff', { before: '', after: '' });
    const file = client.hashFile(new Blob(['abc']));
    client.dispose();
    expect(await second).toMatchObject({ kind: 'error', error: { code: 'ABORTED' } });
    expect(await file).toMatchObject({ kind: 'error', error: { code: 'ABORTED' } });
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledTimes(1);
    const after = await client.run('regex-tester', { pattern: '', text: '' });
    expect(after).toMatchObject({ kind: 'error', error: { code: 'ABORTED' } });
    expect(workers).toHaveLength(3);
  });

  it('does not spawn workers for invalid, pre-aborted or oversized inputs', async () => {
    const { client, workers } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await client.run('regex-tester', { pattern: '', text: '' }, { signal: controller.signal })).toMatchObject({ kind: 'error', error: { code: 'ABORTED' } });
    expect(await client.run('regex-tester', { pattern: 'x', flags: 'uv', text: '' })).toMatchObject({ kind: 'error', error: { code: 'INVALID_INPUT' } });
    class Oversized extends Blob { override get size() { return LIMITS.fileBytes + 1; } }
    expect(await client.hashFile(new Oversized())).toMatchObject({ kind: 'error', error: { code: 'LIMIT_EXCEEDED' } });
    expect(workers).toHaveLength(0);
  });

  it('rejects malformed responses, wrong jobs and wrong tool IDs', async () => {
    for (const response of [
      null, {}, { kind: 'complete', jobId: '1', toolId: 'regex-tester', result: { kind: 'result', data: {} } },
      { kind: 'complete', jobId: 'wrong', toolId: 'regex-tester', result: { kind: 'error', error: { code: 'ABORTED', message: 'x', issues: [] } } },
      { kind: 'complete', jobId: '1', toolId: 'text-diff', result: { kind: 'error', error: { code: 'ABORTED', message: 'x', issues: [] } } },
      { kind: 'progress', jobId: '1', progress: { phase: 'reading', completed: 2, total: 1, unit: 'bytes' } },
    ]) {
      const { client, workers } = setup();
      const result = client.run('regex-tester', { pattern: '', text: '' });
      const rejected = expect(result).rejects.toThrow(/Worker/);
      workers[0]!.receive(response);
      await rejected;
      expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    }
  });

  it('passes Blobs without buffering, delivers progress, and terminates on callback faults', async () => {
    const { client, workers } = setup();
    const file = new Blob(['abc']);
    const read = vi.spyOn(file, 'arrayBuffer');
    const progress = vi.fn();
    const result = client.hashFile(file, undefined, { onProgress: progress });
    expect(read).not.toHaveBeenCalled();
    expect(workers[0]!.sent[0]).toMatchObject({ kind: 'hash-file', file });
    workers[0]!.receive({ kind: 'progress', jobId: '1', progress: { phase: 'reading', completed: 0, total: 3, unit: 'bytes' } });
    expect(progress).toHaveBeenCalledTimes(1);
    await dispatchWorkerRequest(workers[0]!.sent[0], (reply) => workers[0]!.receive(reply));
    expect(await result).toMatchObject({ kind: 'result', data: { source: 'file', byteLength: 3 } });
    const failure = client.hashFile(file, undefined, { onProgress: () => { throw new Error('Consumer bug'); } });
    const rejected = expect(failure).rejects.toThrow('Consumer bug');
    workers[1]!.receive({ kind: 'progress', jobId: '2', progress: { phase: 'reading', completed: 0, total: 3, unit: 'bytes' } });
    await rejected;
    expect(workers[1]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects worker execution, serialization, and postMessage faults', async () => {
    const { client, workers } = setup();
    const result = client.run('regex-tester', { pattern: '', text: '' });
    const rejected = expect(result).rejects.toThrow('Algorithm bug');
    workers[0]!.error('Algorithm bug');
    await rejected;
    const result2 = client.run('regex-tester', { pattern: '', text: '' });
    const rejected2 = expect(result2).rejects.toThrow('deserialized');
    workers[1]!.dispatchEvent(new Event('messageerror'));
    await rejected2;
    const worker = new MockWorker();
    vi.spyOn(worker, 'postMessage').mockImplementation(() => { throw new Error('Clone failure'); });
    await expect(createWorkerClient(() => worker).run('regex-tester', { pattern: '', text: '' })).rejects.toThrow('Clone failure');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects non-monotonic or inconsistent file progress', async () => {
    const { client, workers } = setup();
    const result = client.hashFile(new Blob(['abc']));
    const rejected = expect(result).rejects.toThrow('inconsistent');
    workers[0]!.receive({ kind: 'progress', jobId: '1', progress: { phase: 'processing', completed: 2, total: 3, unit: 'bytes' } });
    workers[0]!.receive({ kind: 'progress', jobId: '1', progress: { phase: 'processing', completed: 1, total: 3, unit: 'bytes' } });
    await rejected;
  });
  it('rejects a well-shaped hash reply for the wrong source or algorithm', async () => {
    const { client, workers } = setup();
    const result = client.hashFile(new Blob(['abc']));
    const rejected = expect(result).rejects.toThrow('input source');
    workers[0]!.receive({
      kind: 'complete', jobId: '1', toolId: 'sha-checksums',
      result: { kind: 'result', notices: [], data: { source: 'text', byteLength: 3, hashes: [{ algorithm: 'SHA-256', digest: '0'.repeat(64) }] } },
    });
    await rejected;
    const result2 = client.run('sha-checksums', { text: 'abc', algorithms: ['SHA-256'] });
    const rejected2 = expect(result2).rejects.toThrow('algorithms');
    workers[1]!.receive({
      kind: 'complete', jobId: '2', toolId: 'sha-checksums',
      result: { kind: 'result', notices: [], data: { source: 'text', byteLength: 3, hashes: [{ algorithm: 'SHA-512', digest: '0'.repeat(128) }] } },
    });
    await rejected2;
  });

  it('dispatches browser facade calls instead of executing blocked algorithms on the main thread', async () => {
    vi.useFakeTimers();
    const workers: MockWorker[] = [];
    class BrowserWorker extends MockWorker {
      constructor(readonly url: URL, readonly options: WorkerOptions) { super(); workers.push(this); }
    }
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', BrowserWorker);
    const result = executeLocalTool('regex-tester', { pattern: '(a+)+$', text: 'a'.repeat(100) + '!' });
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent[0]).toMatchObject({ kind: 'run', toolId: 'regex-tester' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ kind: 'error', error: { code: 'TIMEOUT' } });
    const hashed = hashFile(new Blob(['abc']));
    expect(workers[1]!.sent[0]?.kind).toBe('hash-file');
    await dispatchWorkerRequest(workers[1]!.sent[0], (reply) => workers[1]!.receive(reply));
    expect(await hashed).toMatchObject({ kind: 'result' });
  });
});

describe('worker entry dispatcher', () => {
  it('runs each approved worker tool without recursive spawning', async () => {
    const responses: WorkerResponse[] = [];
    const requests: WorkerRequest[] = [
      { kind: 'run', jobId: 'regex', toolId: 'regex-tester', input: { pattern: 'a', text: 'abc' } },
      { kind: 'run', jobId: 'diff', toolId: 'text-diff', input: { before: 'a', after: 'b' } },
      { kind: 'run', jobId: 'sha', toolId: 'sha-checksums', input: { text: 'abc' } },
      { kind: 'hash-file', jobId: 'file', file: new Blob(['abc']), options: { algorithms: ['SHA-256'] } },
    ];
    for (const request of requests) await dispatchWorkerRequest(request, (reply) => responses.push(reply));
    expect(responses.filter((reply) => reply.kind === 'complete')).toHaveLength(4);
    expect(responses.some((reply) => reply.kind === 'progress')).toBe(true);
  });
  it('rejects invalid envelopes while returning explicit errors for invalid tool inputs', async () => {
    const post = vi.fn();
    for (const request of [null, {}, { kind: 'run', jobId: '', toolId: 'regex-tester' }, { kind: 'run', jobId: 'id', toolId: 'unknown', input: {} }]) {
      await expect(dispatchWorkerRequest(request, post)).rejects.toThrow('Invalid worker request');
    }
    expect(post).not.toHaveBeenCalled();
    await dispatchWorkerRequest({ kind: 'run', jobId: 'id', toolId: 'regex-tester', input: { pattern: '', text: '', flags: 'gg' } }, post);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'complete', jobId: 'id', result: expect.objectContaining({ kind: 'error' }) }));
  });
});
