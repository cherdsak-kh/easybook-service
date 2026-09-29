import { Injectable, Logger } from '@nestjs/common';
import { LineCredentialsService } from '../line/line-credentials.service';
import { LineService } from '../line/line.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  HEALTH_FAILURE_TTL_SECONDS,
  HEALTH_LINE_KEY,
  HEALTH_R2_KEY,
} from '../redis/cache-keys';
import { CACHE_TTL_SECONDS } from '../redis/redis.constants';
import { RedisService } from '../redis/redis.service';
import { R2StorageService } from '../storage/r2-storage.service';
import type { Actor } from '../system-users/system-users.policy';
import { mayReadSystemTelemetry } from '../system-users/system-users.policy';
import {
  HealthDetail,
  HealthOverall,
  HealthServiceStatus,
  type SystemHealthResponseDto,
} from './dto/system-health.dto';

/** Time-box per probe (design §2.4, AC-D19: the whole endpoint must answer within 5 s). */
const DB_PROBE_TIMEOUT_MS = 2_000;
const LINE_PROBE_TIMEOUT_MS = 3_000;
const R2_PROBE_TIMEOUT_MS = 3_000;

type UpOrDown = HealthServiceStatus.UP | HealthServiceStatus.DOWN;

interface CachedLineProbe {
  status: UpOrDown;
  quotaTotal: number | null;
  quotaUsed: number | null;
  /** ISO 8601 — Redis round-trips through JSON, so this is a string, never a `Date`. */
  observedAt: string;
}
type LineProbeResult =
  { status: HealthServiceStatus.NOT_CONFIGURED } | CachedLineProbe;

interface CachedR2Probe {
  status: UpOrDown;
  latencyMs: number;
  observedAt: string;
}
type StorageProbeResult =
  { status: HealthServiceStatus.NOT_CONFIGURED } | CachedR2Probe;

/** Races `promise` against `ms`; the timeout rejects, it never resolves — same shape as `line-call-error.ts`'s `withTimeout`. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  promise.catch(() => undefined); // an abandoned rejection must never become "unhandled".
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `GET /system/health` — design §2.4. Card 4 + the system strip (AC-D16–AC-D20).
 *
 * ⚠️ NEVER THROWS, NEVER RETURNS ANYTHING OTHER THAN 200. A probe failure is a `DOWN` chip, not an
 * exception — this is a REPORT, not a readiness gate; `GET /health`'s 503 semantics are untouched and
 * this service does not call it. Each probe is individually time-boxed, so the total is bounded well
 * under AC-D19's 5 s even when every probe fails.
 *
 * ⚠️ ROLE SHAPING HAPPENS HERE, NEVER IN THE CACHE. The LINE/R2 cache holds the same role-agnostic
 * payload for everyone (design §2.1) — trimming to `telemetry: null` happens when THIS method builds
 * the response, so an ADMIN/VIEWER body never contains a latency, quota or `observedAt` key at all
 * (AC-D17; the e2e spec asserts this on the raw JSON, not the DOM).
 */
@Injectable()
export class SystemHealthService {
  private readonly logger = new Logger(SystemHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lineCredentials: LineCredentialsService,
    private readonly line: LineService,
    private readonly storage: R2StorageService,
    private readonly redis: RedisService,
  ) {}

  async check(actor: Actor): Promise<SystemHealthResponseDto> {
    const [database, line, storage] = await Promise.all([
      this.probeDatabase(),
      this.probeLine(),
      this.probeStorage(),
    ]);

    const overall =
      database.status === HealthServiceStatus.DOWN ||
      line.status === HealthServiceStatus.DOWN ||
      storage.status === HealthServiceStatus.DOWN
        ? HealthOverall.DEGRADED
        : HealthOverall.OK;

    const detail = mayReadSystemTelemetry(actor)
      ? HealthDetail.FULL
      : HealthDetail.SUMMARY;

    return {
      checkedAt: new Date(),
      overall,
      detail,
      services: {
        database: { status: database.status },
        line: { status: line.status },
        storage: { status: storage.status },
      },
      telemetry:
        detail === HealthDetail.FULL
          ? {
              database: { latencyMs: database.latencyMs },
              line:
                line.status === HealthServiceStatus.NOT_CONFIGURED
                  ? {
                      quotaTotal: null,
                      quotaUsed: null,
                      quotaRemaining: null,
                      observedAt: null,
                    }
                  : {
                      quotaTotal: line.quotaTotal,
                      quotaUsed: line.quotaUsed,
                      quotaRemaining:
                        line.quotaTotal !== null
                          ? Math.max(0, line.quotaTotal - (line.quotaUsed ?? 0))
                          : null,
                      observedAt: new Date(line.observedAt),
                    },
              storage:
                storage.status === HealthServiceStatus.NOT_CONFIGURED
                  ? { latencyMs: null, observedAt: null }
                  : {
                      latencyMs: storage.latencyMs,
                      observedAt: new Date(storage.observedAt),
                    },
            }
          : null,
    };
  }

  /** Time-boxed `SELECT 1`, with latency — never `NOT_CONFIGURED` (the DB is always configured). Live every call (D-8). */
  private async probeDatabase(): Promise<{
    status: UpOrDown;
    latencyMs: number;
  }> {
    const started = Date.now();
    try {
      await raceTimeout(this.prisma.$queryRaw`SELECT 1`, DB_PROBE_TIMEOUT_MS);
      return {
        status: HealthServiceStatus.UP,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      this.logger.warn(
        `DB health probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        status: HealthServiceStatus.DOWN,
        latencyMs: Date.now() - started,
      };
    }
  }

  /** Cached 300 s on success / 60 s on failure (AC-D20, E-20). `NOT_CONFIGURED` is never cached. */
  private async probeLine(): Promise<LineProbeResult> {
    if (!this.lineCredentials.isConfigured()) {
      return { status: HealthServiceStatus.NOT_CONFIGURED };
    }
    const cached = await this.redis.getJson<CachedLineProbe>(HEALTH_LINE_KEY);
    if (cached) return cached;

    try {
      const quota = await raceTimeout(
        this.line.getMessageQuota(),
        LINE_PROBE_TIMEOUT_MS,
      );
      const result: CachedLineProbe = {
        status: HealthServiceStatus.UP,
        quotaTotal: quota.total,
        quotaUsed: quota.used,
        observedAt: new Date().toISOString(),
      };
      await this.redis.setJson(HEALTH_LINE_KEY, result, CACHE_TTL_SECONDS);
      return result;
    } catch (error) {
      this.logger.warn(
        `LINE health probe failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      const result: CachedLineProbe = {
        status: HealthServiceStatus.DOWN,
        quotaTotal: null,
        quotaUsed: null,
        observedAt: new Date().toISOString(),
      };
      await this.redis.setJson(
        HEALTH_LINE_KEY,
        result,
        HEALTH_FAILURE_TTL_SECONDS,
      );
      return result;
    }
  }

  /** Cached 300 s on success / 60 s on failure (AC-D20, E-20). `NOT_CONFIGURED` is never cached. */
  private async probeStorage(): Promise<StorageProbeResult> {
    if (!this.storage.isConfigured()) {
      return { status: HealthServiceStatus.NOT_CONFIGURED };
    }
    const cached = await this.redis.getJson<CachedR2Probe>(HEALTH_R2_KEY);
    if (cached) return cached;

    // `probeRead` never throws — see `r2-storage.service.ts`.
    const probe = await this.storage.probeRead(R2_PROBE_TIMEOUT_MS);
    const result: CachedR2Probe = {
      status: probe.ok ? HealthServiceStatus.UP : HealthServiceStatus.DOWN,
      latencyMs: probe.latencyMs,
      observedAt: new Date().toISOString(),
    };
    await this.redis.setJson(
      HEALTH_R2_KEY,
      result,
      probe.ok ? CACHE_TTL_SECONDS : HEALTH_FAILURE_TTL_SECONDS,
    );
    return result;
  }
}
