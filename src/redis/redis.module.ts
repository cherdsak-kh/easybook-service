import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * The one shared `ioredis` client (session store + login rate limiter).
 *
 * No client-level `keyPrefix`: it would apply to every command, including connect-redis's.
 * Namespacing is per-consumer, under the disjoint `eb:sess:` and `eb:throttle:` prefixes.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const logger = new Logger('RedisClient');
        const client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
          // Fail CLOSED. Commands issued while disconnected reject immediately instead of
          // silently queueing until a reconnect.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 3000,
          // Eager connect (NOT lazyConnect) so ioredis owns reconnection forever, and the app
          // still boots with Redis down.
          retryStrategy: (times: number) => Math.min(times * 200, 5000),
        });

        client.on('ready', () => logger.log('Redis connection ready.'));
        client.on('end', () => logger.warn('Redis connection closed.'));
        client.on('reconnecting', (ms: number) =>
          logger.warn(`Redis reconnecting in ${ms}ms.`),
        );
        // Fires once per retry attempt. Loud on purpose — a down session store must be visible.
        client.on('error', (error: Error) =>
          logger.error(`Redis error: ${error.message}`),
        );

        return client;
      },
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
