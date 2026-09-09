import { DiagnosticError, checkAbort } from './errors.js';
import { SERVICE_LIMITS } from './config.js';

export class ConnectionLimiter {
  private active = 0;
  constructor(readonly maximum: number = SERVICE_LIMITS.outboundConnections) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > SERVICE_LIMITS.outboundConnections) {
      throw new Error('Invalid outbound connection limit.');
    }
  }

  acquire(signal: AbortSignal): () => void {
    checkAbort(signal, 'connect');
    if (this.active >= this.maximum) throw new DiagnosticError('RATE_LIMITED', 'service');
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}

export class RequestBudget {
  queries = 0;
  constructor(readonly signal: AbortSignal, readonly maximum: number) {}
  query(): void {
    checkAbort(this.signal, 'dns');
    if (this.queries >= this.maximum) throw new DiagnosticError('LIMIT_EXCEEDED', 'dns');
    this.queries++;
  }
}

interface RateWindow { count: number; until: number }

export class Admission {
  private active = 0;
  private global: RateWindow = { count: 0, until: 0 };
  private sources = new Map<string, RateWindow>();

  enter(ip: string, now = Date.now()): () => void {
    if (now >= this.global.until) this.global = { count: 0, until: now + 60_000 };
    for (const [key, value] of this.sources) {
      if (value.until <= now) this.sources.delete(key);
    }
    let source = this.sources.get(ip);
    if (!source) {
      if (this.sources.size >= SERVICE_LIMITS.sourceEntries) {
        throw new DiagnosticError('RATE_LIMITED', 'service');
      }
      source = { count: 0, until: now + 60_000 };
      this.sources.set(ip, source);
    }
    if (this.active >= SERVICE_LIMITS.concurrentRequests
      || this.global.count >= SERVICE_LIMITS.requestsPerMinute
      || source.count >= SERVICE_LIMITS.requestsPerIpMinute) {
      throw new DiagnosticError('RATE_LIMITED', 'service');
    }
    this.global.count++;
    source.count++;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}
