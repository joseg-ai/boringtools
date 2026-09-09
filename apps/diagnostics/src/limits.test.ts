import { describe, expect, it } from 'vitest';
import { Admission, ConnectionLimiter } from './limits.js';
import { SERVICE_LIMITS } from './config.js';

describe('per-replica admission and capacity', () => {
  it('enforces global request limits independently of source IP and resets only after the window', () => {
    const admission = new Admission();
    for (let index = 0; index < SERVICE_LIMITS.requestsPerMinute; index++) {
      admission.enter(`source-${index}`, 0)();
    }
    expect(() => admission.enter('new-source', 59_999)).toThrow();
    expect(() => admission.enter('new-source', 60_000)()).not.toThrow();
  });

  it('does not evict live source counters to admit new entries when the bounded map fills', () => {
    const admission = new Admission();
    for (let index = 0; index < SERVICE_LIMITS.sourceEntries; index++) {
      try { admission.enter(`source-${index}`, 0)(); } catch (error) {
        expect(error).toMatchObject({ detail: { code: 'RATE_LIMITED' } });
      }
    }
    expect(() => admission.enter('another-source', 1)).toThrow();
    expect(() => admission.enter('another-source', 60_000)()).not.toThrow();
  });

  it('shares a hard connection ceiling regardless of source and releases exactly once', () => {
    const limiter = new ConnectionLimiter();
    const signal = new AbortController().signal;
    const releases = Array.from({ length: SERVICE_LIMITS.outboundConnections }, () => limiter.acquire(signal));
    expect(() => limiter.acquire(signal)).toThrow();
    releases[0]!();
    releases[0]!();
    const release = limiter.acquire(signal);
    expect(() => limiter.acquire(signal)).toThrow();
    release();
    for (const done of releases) done();
    expect(() => new ConnectionLimiter(SERVICE_LIMITS.outboundConnections + 1)).toThrow();
  });
});
