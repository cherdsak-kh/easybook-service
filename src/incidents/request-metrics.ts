import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { bangkokDate } from '../reports/report-calendar';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { INCIDENT_KEY_ROOT, METRIC_TTL_DAYS } from './incidents.constants';

const METRIC_TTL_SECONDS = METRIC_TTL_DAYS * 86_400;
/** Outage deltas beyond this many distinct days are dropped (bounded; a clock cannot produce more). */
const PENDING_DAYS_MAX = 7;

export interface AvailabilityCounts {
  requests: number;
  failed: number;
  /** Range days with no request counter at all (a flush, an outage, or a day before this shipped). */
  daysWithoutData: number;
}

/** `YYYYMMDD` of the Bangkok day `at` falls on. */
export const metricDayOf = (at: Date): string =>
  bangkokDate(at).replace(/-/g, '');

/**
 * Per-Bangkok-day request and 5xx counters (D-23): the denominator of the availability KPI.
 *
 * `<root>metrics:req:<YYYYMMDD>` and `<root>metrics:5xx:<YYYYMMDD>`, TTL 100 days. One pipelined
 * `INCR` (+ `EXPIRE`) per request, fired and not awaited; a failure is swallowed. While the client is
 * not `ready` the deltas accumulate in memory and are added with `INCRBY` when it returns, so an outage
 * does not erase its own 5xx. A restart during the outage loses them (documented).
 */
@Injectable()
export class RequestMetrics implements OnModuleDestroy {
  private readonly logger = new Logger(RequestMetrics.name);
  private readonly pending = new Map<string, { req: number; err: number }>();
  private readonly onReady = () => this.flush();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(INCIDENT_KEY_ROOT) private readonly root: string,
  ) {
    this.redis.on('ready', this.onReady);
  }

  onModuleDestroy(): void {
    this.redis.off('ready', this.onReady);
  }

  private reqKey(day: string): string {
    return `${this.root}metrics:req:${day}`;
  }

  private errKey(day: string): string {
    return `${this.root}metrics:5xx:${day}`;
  }

  /** Fire-and-forget. Never throws, never returns a promise the caller could await by mistake. */
  count(at: Date, is5xx: boolean): void {
    try {
      const day = metricDayOf(at);
      if (this.redis.status !== 'ready') {
        this.bump(day, 1, is5xx ? 1 : 0);
        return;
      }
      const pipeline = this.redis.pipeline().incr(this.reqKey(day));
      pipeline.expire(this.reqKey(day), METRIC_TTL_SECONDS);
      if (is5xx) {
        pipeline.incr(this.errKey(day));
        pipeline.expire(this.errKey(day), METRIC_TTL_SECONDS);
      }
      void pipeline.exec().catch(() => this.bump(day, 1, is5xx ? 1 : 0));
    } catch {
      // Counting must never hurt a request.
    }
  }

  private bump(day: string, req: number, err: number): void {
    const cur = this.pending.get(day);
    if (cur) {
      cur.req += req;
      cur.err += err;
      return;
    }
    if (this.pending.size >= PENDING_DAYS_MAX) return;
    this.pending.set(day, { req, err });
  }

  /** Adds the outage deltas back. A failure keeps the rest for the next `ready`. */
  private flush(): void {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    const pipeline = this.redis.pipeline();
    for (const [day, d] of batch) {
      if (d.req > 0) {
        pipeline.incrby(this.reqKey(day), d.req);
        pipeline.expire(this.reqKey(day), METRIC_TTL_SECONDS);
      }
      if (d.err > 0) {
        pipeline.incrby(this.errKey(day), d.err);
        pipeline.expire(this.errKey(day), METRIC_TTL_SECONDS);
      }
    }
    void pipeline.exec().catch(() => {
      for (const [day, d] of batch) this.bump(day, d.req, d.err);
      this.logger.warn(
        'Request counters could not be flushed; kept in memory.',
      );
    });
  }

  /** `MGET` of both counters for each Bangkok `YYYY-MM-DD` day. */
  async read(days: readonly string[]): Promise<AvailabilityCounts> {
    if (days.length === 0) {
      return { requests: 0, failed: 0, daysWithoutData: 0 };
    }
    const compact = days.map((d) => d.replace(/-/g, ''));
    const [reqs, errs] = await Promise.all([
      this.redis.mget(compact.map((d) => this.reqKey(d))),
      this.redis.mget(compact.map((d) => this.errKey(d))),
    ]);
    let requests = 0;
    let failed = 0;
    let daysWithoutData = 0;
    reqs.forEach((value, i) => {
      if (value === null) daysWithoutData += 1;
      else requests += Number(value) || 0;
      failed += Number(errs[i] ?? 0) || 0;
    });
    return { requests, failed, daysWithoutData };
  }
}
