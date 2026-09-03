import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
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
import { OptionsModule } from './options/options.module';
import { VenueTypesModule } from './venue-types/venue-types.module';
import { AmenitiesModule } from './amenities/amenities.module';
import { VenuesModule } from './venues/venues.module';
import { PrismaModule } from './prisma/prisma.module';
import { SystemModule } from './system/system.module';
import { RealtimeModule } from './realtime/realtime.module';
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
    RealtimeModule,
    LineModule,
    AuthModule,
    SystemUsersModule,
    OptionsModule,
    // The venue-side curated vocabularies. Separate modules rather than more
    // controllers on OptionsModule: they share a screen and a response shape with
    // /departments, not a service.
    VenueTypesModule,
    AmenitiesModule,
    // The first real DOMAIN module: `Venue` is the Resource this file's header has been promising
    // since the init migration. It must come after the two above — not for Nest (module order is
    // irrelevant to the injector) but because that is the dependency direction on paper: a venue
    // points at a category and ticks amenities, never the reverse.
    VenuesModule,
    // The second domain module, and the one the product is actually for (`CLIENT-BOOKING-1`). It
    // comes after `VenuesModule` for the same paper reason: a booking points at a venue, never the
    // reverse. Nest's injector does not care about the order, but two things here do — the guard
    // grouping documented on `LineBookingsController`, and the fact that its `line-users/*` routes
    // register after both `LineModule` controllers. That is proven safe in a table on that file; it
    // is not luck, and it is the thing to re-read before adding a route to either.
    BookingsModule,
    SystemModule,
    // Still future tasks: the admin approval + direct-booking surface (`SessionGuard`), the
    // `/client` realtime namespace, and LINE chat notifications.
  ],
  controllers: [AppController],
})
export class AppModule {}
