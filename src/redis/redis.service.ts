import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Lifecycle owner + health probe for the shared Redis client.
 *
 * There is deliberately **no `onModuleInit`** that awaits or throws: eager connect plus
 * `retryStrategy` (see `redis.module.ts`) means the process boots with Redis down, logs the
 * failure loudly, keeps retrying, and recovers on its own. Session-backed requests fail closed
 * with `503` in the meantime — they never silently fall back to an in-memory store.
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
}
