import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { AnnouncementsModule } from './announcements/announcements.module';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { CannedRepliesModule } from './canned-replies/canned-replies.module';
import {
  LOGIN_IP_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_THROTTLE_TTL_MS,
} from './auth/auth.constants';
import {
  LOGIN_IP_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
} from './auth/login-throttle.key';
import { SCHEDULING_ENABLED } from './common/scheduling.constants';
import { validateEnv } from './config/env.validation';
import { CsrfModule } from './csrf/csrf.module';
import { FeedbackModule } from './feedback/feedback.module';
import { HealthModule } from './health/health.module';
import { LineModule } from './line/line.module';
import { NotificationsModule } from './notifications/notifications.module';
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
    // One `forRoot()` per app, registered only outside jest — see `common/scheduling.constants.ts`.
    ...(SCHEDULING_ENABLED ? [ScheduleModule.forRoot()] : []),
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
    // `CLIENT-ISSUE-1` — แจ้งปัญหา / ข้อเสนอแนะ. AFTER `BookingsModule`, and the position is worth a
    // line: its two routes are literals on the shared `line-users/*` family, so they register after
    // both `LineModule` controllers and after `LineBookingsController`. That is safe today because
    // no parameterised POST exists on that family — the table proving it is on
    // `FeedbackController`, and it is the thing to re-read before adding one.
    FeedbackModule,
    // `ANNOUNCE-API-1` — ประกาศและข่าวสาร, phase 1 (persistence + admin CRUD; nothing is broadcast).
    // Its routes are `/announcements…`, a first segment no other controller uses.
    AnnouncementsModule,
    // `ANNOUNCE-API-5` — ข้อความตอบกลับด่วน (canned replies CRUD). Its routes are `/canned-replies…`,
    // a first segment no other controller uses.
    CannedRepliesModule,
    // `NOTIF-API-1` — การแจ้งเตือน, phase 1 (the feed + per-operator read/dismiss state; nothing emits
    // notifications until phase 3). Its routes are `/notifications…`, a first segment no other
    // controller uses.
    NotificationsModule,
    SystemModule,
    // Still future tasks: the admin approval + direct-booking surface (`SessionGuard`), the
    // `/client` realtime namespace, and LINE chat notifications.
  ],
  controllers: [AppController],
})
export class AppModule {}
