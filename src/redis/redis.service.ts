import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  CACHE_KEY_PREFIX,
  CACHE_TTL_SECONDS,
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

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

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
      // warn, not debug: a stale key now outlives its invalidation by up to the full TTL, and
      // that is the shape of every "why does it still show the old name" report.
      this.logger.warn(
        `Cache invalidation failed. keys=${keys.join(',')} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
