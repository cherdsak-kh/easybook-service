import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { AuthModule } from './auth/auth.module';
import {
  LOGIN_IP_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_THROTTLE_TTL_MS,
} from './auth/auth.constants';
import {
  LOGIN_IP_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
} from './auth/login-throttle.key';
import { validateEnv } from './config/env.validation';
import { CsrfModule } from './csrf/csrf.module';
import { HealthModule } from './health/health.module';
import { LineModule } from './line/line.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisThrottlerStorage } from './redis/redis-throttler.storage';
import { REDIS_CLIENT } from './redis/redis.constants';
import { RedisModule } from './redis/redis.module';
import { SystemUsersModule } from './system-users/system-users.module';

/**
 * Two named throttlers, both evaluated on the login route only — there is no `APP_GUARD`, so
 * nothing else in the app is throttled. `ttl` and `blockDuration` are milliseconds in
 * @nestjs/throttler v6; setting `blockDuration === ttl` keeps one counter key per limiter.
 *
 * Marked `global` so `LoginThrottleGuard` (declared in `AuthModule`) can resolve the throttler's
 * options and storage providers, which a dynamic module otherwise exports only to its importers.
 */
const throttlerModule: DynamicModule = {
  ...ThrottlerModule.forRootAsync({
    imports: [RedisModule],
    inject: [REDIS_CLIENT],
    useFactory: (redis: Redis) => ({
      throttlers: [
        {
          name: LOGIN_IP_EMAIL_THROTTLER,
          ttl: LOGIN_THROTTLE_TTL_MS,
          limit: LOGIN_IP_EMAIL_LIMIT,
          blockDuration: LOGIN_THROTTLE_TTL_MS,
        },
        {
          name: LOGIN_IP_THROTTLER,
          ttl: LOGIN_THROTTLE_TTL_MS,
          limit: LOGIN_IP_LIMIT,
          blockDuration: LOGIN_THROTTLE_TTL_MS,
        },
      ],
      // Counters live in Redis, so they survive a backend restart (AC-22) and the per-email one
      // can be cleared by key on a successful login (AC-21).
      storage: new RedisThrottlerStorage(redis),
    }),
  }),
  global: true,
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Boot-time fail-fast on a misconfigured secret. An unreachable Redis is NOT a boot failure.
      validate: validateEnv,
    }),
    PrismaModule,
    RedisModule,
    CsrfModule,
    throttlerModule,
    HealthModule,
    LineModule,
    AuthModule,
    SystemUsersModule,
    // Domain modules (ResourceModule, BookingModule, ...) are added in their own tasks.
  ],
})
export class AppModule {}
