import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { IncidentRecorder } from '../incidents/incident-recorder.service';
import { IncidentComponent } from '../incidents/incident.types';
import {
  CACHE_KEY_PREFIX,
  CACHE_TTL_SECONDS,
  NOTIF_KEY_PREFIX,
  REDIS_CLIENT,
} from './redis.constants';

/**
 * Lifecycle owner + health probe for the shared Redis client.
 *
 * There is deliberately **no `onModuleInit`** that awaits or throws: eager connect plus
 * `retryStrategy` (see `redis.module.ts`) means the process boots with Redis down, logs the
 * failure loudly, keeps retrying, and recovers on its own. Session-backed requests fail closed
 * with `503` in the meantime — they never silently fall back to an in-memory store.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CACHE HELPERS BELOW FAIL **OPEN**, AND THAT IS NOT A CONTRADICTION.
 *
 * The session store fails closed because it holds the only copy of who you are: degrading it
 * means inventing an answer. The cache fails open because PostgreSQL is still sitting right
 * there holding the truth, so degrading it costs a round trip and nothing else. The rule that
 * decides which way a dependency fails is *whether a correct answer is still reachable without
 * it* — not a house style applied uniformly to everything named Redis.
 *
 * So: **no method here throws.** A Redis outage turns every read into a miss and every
 * invalidation into a no-op that the 300s TTL cleans up behind it. What must NEVER appear is a
 * caller that treats a miss as an answer — "not in the cache" must never become "does not
 * exist", "not a duplicate", or "not permitted" (R5). These helpers return `null` for *unknown*,
 * never for *absent*.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /**
   * The in-process fallback for {@link claimOnce} when Redis is down (`NOTIF-EVENTS-1` §2.6, D-9).
   * Bounded in practice: at most 3 C1 kinds and C5 signatures are bounded by routes × error codes.
   * Per-process only — not written back to Redis on recovery. Accepted cost: at most one duplicate
   * notification per window around a Redis outage.
   */
  private readonly localClaims = new Map<string, number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    // Hub 6. LAST and `@Optional()` so the existing spec (one argument) constructs unchanged. Reports
    // only; it never changes what any method here returns or throws.
    @Optional() private readonly incidents?: IncidentRecorder,
  ) {}

  /** Hub 6: a command that FAILED while the client was `ready`. The key family only, never the key. */
  private reportFailure(operation: string, error: unknown, key?: string): void {
    this.incidents?.external({
      component: IncidentComponent.REDIS,
      operation,
      error,
      context: { keyPrefix: key ? key.split(':')[0] : undefined },
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Already closed, or never connected. Nothing to flush.
    } finally {
      // Kills any pending reconnect timer so the process can exit.
      this.client.disconnect();
    }
  }

  /** Time-boxed liveness probe. Mirrors `HealthController.probeDb`; never throws. */
  async isHealthy(): Promise<boolean> {
    if (this.client.status !== 'ready') return false;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis probe timeout')), 2000);
    });
    try {
      await Promise.race([this.client.ping(), timeout]);
      return true;
    } catch (error) {
      this.logger.warn(
        `Redis probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Read a cached value. `null` means "ask PostgreSQL" — for a miss, a parse failure, and a
   * Redis outage alike, because to the caller those three are the same instruction.
   *
   * The `status` check is not an optimisation: with `enableOfflineQueue: false` the command
   * would reject immediately anyway, but issuing it emits a client `error` event, and the client
   * logs those at `error` level. One per request while Redis is down would bury the outage in
   * the noise it caused.
   */
  async getJson<T>(key: string): Promise<T | null> {
    if (this.client.status !== 'ready') return null;
    try {
      const raw = await this.client.get(CACHE_KEY_PREFIX + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.reportFailure('getJson', error, key);
      // debug, not warn: this fires once per request for the whole outage, and the client has
      // already said so loudly at `error` level exactly once per retry.
      this.logger.debug(
        `Cache read skipped. key=${key} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Fill a cache key. Always with a TTL — `set(key, value)` with no expiry is unreachable
   * through this API, and that is deliberate (R4).
   *
   * ⚠️ **Only the read path may call this.** A write path that fills the cache is the
   * DB-then-Redis pair that cannot be atomic: die between the two and Redis holds the stale
   * value until someone happens to edit that row again. Writes call `del` (R2).
   */
  async setJson(
    key: string,
    value: unknown,
    ttlSeconds: number = CACHE_TTL_SECONDS,
  ): Promise<void> {
    if (this.client.status !== 'ready') return;
    try {
      await this.client.set(
        CACHE_KEY_PREFIX + key,
        JSON.stringify(value),
        'EX',
        ttlSeconds,
      );
    } catch (error) {
      this.reportFailure('setJson', error, key);
      this.logger.debug(
        `Cache fill skipped. key=${key} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Drop cache keys after a write (R2). Variadic and EXACT — there is no pattern form.
   *
   * The plan said `del(pattern)`; a pattern needs `KEYS`, which is O(keyspace) and blocks
   * single-threaded Redis for the duration, or a `SCAN` loop, which is a cursor to get wrong. It
   * buys nothing here: every key family is enumerable at the call site (`opt:*` is two keys, the
   * per-entity ones are one each). If a family ever stops being enumerable, that is the signal
   * the key is wrong — not the signal to add a glob.
   *
   * A failure is swallowed: the write already committed to PostgreSQL and must not be reported
   * as failed because the cleanup did. The TTL is what bounds the damage, which is the whole
   * reason it has no exceptions.
   */
  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0 || this.client.status !== 'ready') return;
    try {
      await this.client.del(...keys.map((k) => CACHE_KEY_PREFIX + k));
    } catch (error) {
      this.reportFailure('del', error, keys[0]);
      // warn, not debug: a stale key now outlives its invalidation by up to the full TTL, and
      // that is the shape of every "why does it still show the old name" report.
      this.logger.warn(
        `Cache invalidation failed. keys=${keys.join(',')} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `SET key 1 NX EX ttl` under `eb:notif:` — a throttle CLAIM, not a cache read (`NOTIF-EVENTS-1`
   * §2.6). `true` means the caller owns this window and should act; `false` means someone already
   * claimed it. NEVER throws.
   *
   * 🔴 THE CLAIM IS TAKEN BEFORE `create()` AND IS NEVER RELEASED (D-9) — a failed `create()` still
   * consumes the window. Releasing it on failure would turn every 500 into a slow insert attempt
   * with the DB down, which is exactly the storm this exists to prevent.
   */
  async claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    if (this.client.status === 'ready') {
      try {
        const result = await this.client.set(
          NOTIF_KEY_PREFIX + key,
          '1',
          'EX',
          ttl,
          'NX',
        );
        return result === 'OK';
      } catch (error) {
        this.reportFailure('claimOnce', error, key);
        this.logger.debug(
          `Notification claim fell back to memory. key=${key} reason=${error instanceof Error ? error.message : String(error)}`,
        );
        return this.claimLocally(key, ttl);
      }
    }
    return this.claimLocally(key, ttl);
  }

  /** The in-process fallback half of {@link claimOnce}. Prunes expired entries on every call. */
  private claimLocally(key: string, ttlSeconds: number): boolean {
    const now = Date.now();
    for (const [k, expiresAt] of this.localClaims) {
      if (expiresAt <= now) this.localClaims.delete(k);
    }
    if ((this.localClaims.get(key) ?? 0) > now) return false;
    this.localClaims.set(key, now + ttlSeconds * 1000);
    return true;
  }
}
