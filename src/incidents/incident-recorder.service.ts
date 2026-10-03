import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  classifyExternal,
  classifyHttp,
  errorCodeOf,
} from './incident-classify';
import { buildRecord } from './incident-redact';
import { IncidentStore } from './incident-store';
import {
  DRAFTS_PER_REQUEST_MAX,
  INCIDENT_FIFO,
  MESSAGE_MAX,
  SIGNATURE_LIMIT,
  SIGNATURE_WINDOW_MS,
  STORE_WARN_INTERVAL_MS,
} from './incidents.constants';
import {
  IncidentComponent,
  IncidentSeverity,
  type ExternalOutcome,
  type IncidentDraft,
  type IncidentDraftRecord,
  type TraceContext,
} from './incident.types';
import { currentTrace } from './trace-context';

interface SignatureState {
  windowStart: number;
  count: number;
  suppressed: number;
  last: IncidentDraftRecord | null;
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  [IncidentSeverity.CRITICAL]: 0,
  [IncidentSeverity.ERROR]: 1,
  [IncidentSeverity.WARNING]: 2,
};

const newSystemTraceId = (): string => `tr-${randomBytes(8).toString('hex')}`;

/**
 * Hub 6's recorder (design §2.5.1, D-19, D-20).
 *
 * 🔴 FIRE-AND-FORGET AND FAIL-OPEN. Nothing here throws into a request, awaits on a request's path, or
 * changes a status, body or header. Every public method wraps its body in `try/catch`; a store failure
 * is logged at most once a minute (ids only, never a message) and the incident goes to a bounded
 * per-process FIFO that is flushed when Redis returns.
 *
 * 🔴 NON-RECURSIVE. The store talks to the raw ioredis client, never `RedisService`, and nothing in
 * this class calls a wrapped dependency, so "Redis is down" is recorded without trying Redis again.
 */
@Injectable()
export class IncidentRecorder implements OnModuleDestroy {
  private readonly logger = new Logger(IncidentRecorder.name);
  private readonly fifo: IncidentDraftRecord[] = [];
  private readonly signatures = new Map<string, SignatureState>();
  private lastStoreWarnAt = 0;
  private redisDownRecorded = false;
  private flushing = false;
  private readonly sweepTimer: NodeJS.Timeout;

  private readonly onReady = () => {
    this.redisDownRecorded = false;
    void this.flush();
  };
  private readonly onError = (error: Error) => {
    // The client emits `error` once per reconnect attempt; one incident per outage is enough.
    if (this.redisDownRecorded) return;
    this.redisDownRecorded = true;
    this.external({
      component: IncidentComponent.REDIS,
      operation: 'connection',
      error,
    });
  };

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly store: IncidentStore,
  ) {
    this.redis.on('ready', this.onReady);
    this.redis.on('error', this.onError);
    this.sweepTimer = setInterval(
      () => this.sweepSignatures(),
      SIGNATURE_WINDOW_MS,
    );
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
    this.redis.off('ready', this.onReady);
    this.redis.off('error', this.onError);
  }

  /** Incidents waiting in the outage buffer (tests, and the documented loss case). */
  get bufferedCount(): number {
    return this.fifo.length;
  }

  /**
   * An external call's outcome (LINE / R2 / Redis). Inside a live request it joins that request's
   * drafts (so the 5xx it causes is ONE incident); outside one (cron, worker, after the response) it is
   * recorded at once with a system caller and a fresh trace id.
   */
  external(outcome: ExternalOutcome): void {
    try {
      const cls = classifyExternal(outcome);
      if (!cls) return;
      const retried = (outcome.attempts ?? 1) > 1;
      const failed = outcome.error !== undefined;
      const draft: IncidentDraft = {
        severity: cls.severity,
        component: outcome.component,
        atMs: Date.now(),
        error: outcome.error,
        errorCode: failed ? errorCodeOf(outcome.error) : null,
        operation: outcome.operation,
        message: failed
          ? undefined
          : retried
            ? `${outcome.operation} succeeded only after ${outcome.attempts} attempts`
            : `${outcome.operation} took ${outcome.latencyMs} ms (budget ${outcome.budgetMs} ms)`,
        context: {
          ...outcome.context,
          attempts: outcome.attempts,
          latencyMs: outcome.latencyMs,
          budgetMs: outcome.budgetMs,
          lineErrorKind: cls.lineErrorKind,
          upstreamStatus: cls.status,
        },
      };
      const ctx = currentTrace();
      if (ctx && !ctx.closed) {
        if (ctx.drafts.length < DRAFTS_PER_REQUEST_MAX) ctx.drafts.push(draft);
        return;
      }
      this.persist(
        buildRecord({
          draft,
          req: null,
          traceId: newSystemTraceId(),
          status: null,
          method: null,
        }),
      );
    } catch {
      // Recording must never hurt the caller.
    }
  }

  /**
   * Runs `fn`, reports a failure or a slow success, and returns/rethrows exactly what `fn` did: the
   * same value, the same error object, no extra `await` on the recorder.
   */
  async track<T>(
    component: IncidentComponent,
    operation: string,
    budgetMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await fn();
      this.external({
        component,
        operation,
        latencyMs: Date.now() - startedAt,
        budgetMs,
      });
      return result;
    } catch (error) {
      this.external({
        component,
        operation,
        error,
        latencyMs: Date.now() - startedAt,
        budgetMs,
      });
      throw error;
    }
  }

  /**
   * Called exactly once per request, on `finish`/`close`. A 5xx becomes ONE incident; a 4xx or 2xx
   * never becomes one by its status (D-19c), only by the external drafts it collected.
   */
  settle(ctx: TraceContext, status: number): void {
    if (ctx.closed) return;
    ctx.closed = true;
    try {
      const base = { req: ctx.req, traceId: ctx.traceId, method: ctx.method };
      if (status >= 500) {
        const http = this.httpDraft(ctx, status);
        const best = [...ctx.drafts, http].reduce((a, b) =>
          SEVERITY_RANK[b.severity] < SEVERITY_RANK[a.severity] ? b : a,
        );
        this.persist(buildRecord({ ...base, draft: best, status }));
        return;
      }
      for (const draft of ctx.drafts) {
        this.persist(buildRecord({ ...base, draft, status }));
      }
    } catch {
      // A bug here must never reach the response that already finished.
    }
  }

  private httpDraft(ctx: TraceContext, status: number): IncidentDraft {
    const route =
      typeof ctx.req.route?.path === 'string' ? ctx.req.route.path : null;
    const cls = classifyHttp(ctx.error, route, this.redis.status === 'ready');
    return {
      severity: cls.severity,
      component: cls.component,
      atMs: Date.now(),
      error: ctx.error,
      errorCode: ctx.error === undefined ? null : errorCodeOf(ctx.error),
      operation: ctx.error === undefined ? 'middleware' : undefined,
      message:
        ctx.error === undefined
          ? `HTTP ${status} raised before the route handler`
          : undefined,
    };
  }

  // ── storage ──────────────────────────────────────────────────────────

  /** Storm control (E-13), then the store (or the outage buffer). */
  private persist(record: IncidentDraftRecord): void {
    if (!this.admit(record)) return;
    this.send(record);
  }

  private send(record: IncidentDraftRecord): void {
    if (this.redis.status !== 'ready') {
      this.pushFifo(record);
      return;
    }
    this.store.add(record).catch((error: unknown) => {
      this.warnStore(error);
      this.pushFifo(record);
    });
  }

  private pushFifo(record: IncidentDraftRecord): void {
    this.fifo.push(record);
    while (this.fifo.length > INCIDENT_FIFO) this.fifo.shift();
  }

  /** Oldest-first through the same `add`. A failure stops the flush and keeps the rest. */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.fifo.length > 0 && this.redis.status === 'ready') {
        const next = this.fifo[0];
        await this.store.add(next);
        this.fifo.shift();
      }
    } catch (error) {
      this.warnStore(error);
    } finally {
      this.flushing = false;
    }
  }

  private warnStore(error: unknown): void {
    const now = Date.now();
    if (now - this.lastStoreWarnAt < STORE_WARN_INTERVAL_MS) return;
    this.lastStoreWarnAt = now;
    // Names the failure class only: a Redis error message can carry a host, never an incident's content.
    this.logger.warn(
      `Incident store write failed; buffering in memory. reason=${error instanceof Error ? error.name : 'unknown'}`,
    );
  }

  // ── storm control ────────────────────────────────────────────────────

  private admit(record: IncidentDraftRecord): boolean {
    const signature = [
      record.component,
      record.severity,
      record.status,
      record.method,
      record.routeTemplate,
      record.errorCode,
    ].join('|');
    const now = Date.now();
    const state = this.signatures.get(signature);
    if (!state || now - state.windowStart >= SIGNATURE_WINDOW_MS) {
      this.signatures.set(signature, {
        windowStart: now,
        count: 1,
        suppressed: 0,
        last: null,
      });
      if (state) this.emitSuppressed(state);
      return true;
    }
    if (state.count < SIGNATURE_LIMIT) {
      state.count += 1;
      return true;
    }
    state.suppressed += 1;
    state.last = record;
    return false;
  }

  /** One incident, cloned from the last suppressed one, standing for the rest of the window. */
  private emitSuppressed(state: SignatureState): void {
    if (state.suppressed === 0 || !state.last) return;
    const suffix = ` (+${state.suppressed} similar incidents suppressed in ${SIGNATURE_WINDOW_MS / 1000} s)`;
    this.send({
      ...state.last,
      atMs: Date.now(),
      message:
        state.last.message.slice(0, MESSAGE_MAX - suffix.length) + suffix,
      context: { ...state.last.context, suppressedCount: state.suppressed },
    });
  }

  private sweepSignatures(): void {
    try {
      const now = Date.now();
      for (const [signature, state] of this.signatures) {
        if (now - state.windowStart < SIGNATURE_WINDOW_MS) continue;
        this.signatures.delete(signature);
        this.emitSuppressed(state);
      }
    } catch {
      // Timer callback: never throws.
    }
  }
}
