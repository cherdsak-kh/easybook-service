import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

/** `@nestjs/throttler` does not re-export this interface from its entrypoint. */
type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/**
 * Redis-backed counter store for `@nestjs/throttler` (DD-1).
 *
 * `ThrottlerGuard` still owns the algorithm; this owns only the key strings — which AC-21 needs
 * (clear one email's counter on a successful login) and AC-22 verifies (counters survive a
 * restart). A third-party adapter's internal key naming is undocumented and version-unstable,
 * so reconstructing its keys in order to delete one would be brittle.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  /**
   * `ThrottlerStorage.increment` also passes `blockDuration` and `throttlerName`; both are
   * deliberately unimplemented. We configure `blockDuration === ttl`, which means one counter key
   * per limiter and no separate `:blocked` key, and the throttler name is already baked into the
   * key by `LoginThrottleGuard.generateKey`.
   */
  async increment(
    key: string,
    ttlMs: number,
    limit: number,
  ): Promise<ThrottlerStorageRecord> {
    try {
      // Atomic: create-with-TTL-if-absent, then increment, then read the remaining TTL.
      // Inside one MULTI there is no window where the key exists without a TTL.
      const res = await this.redis
        .multi()
        .set(key, 0, 'PX', ttlMs, 'NX')
        .incr(key)
        .pttl(key)
        .exec();

      if (!res) throw new Error('Redis MULTI was aborted.');

      const totalHits = Number(res[1][1]);
      const pttl = Number(res[2][1]);
      const timeToExpire = Math.ceil((pttl > 0 ? pttl : ttlMs) / 1000); // seconds
      const isBlocked = totalHits > limit;

      return {
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: isBlocked ? timeToExpire : 0,
      };
    } catch (error) {
      // Fail CLOSED. A rate limiter that "allows on error" is not a rate limiter.
      this.logger.error(
        `Rate-limit store failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('Rate limiter unavailable.');
    }
  }
}
