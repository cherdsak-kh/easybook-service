import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  SCHEDULING_ENABLED,
  schedulingEnabled,
} from '../common/scheduling.constants';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { AdminNotificationTriggers } from './triggers/admin-notification-triggers.service';
import { ServerErrorNotificationInterceptor } from './triggers/server-error.interceptor';
import { ADMIN_NOTIFICATION_TRIGGERS_ENABLED } from './triggers/triggers.constants';
import { VersionAnnouncer } from './triggers/version-announcer';

/**
 * `การแจ้งเตือน` — `NOTIF-API-1` (phase 1: the `AdminNotification` feed and each operator's private
 * read/dismiss state) PLUS `NOTIF-EVENTS-1` (phase 3: the 15 operational triggers).
 *
 * ── ONE IMPORT: `RealtimeModule` (`NOTIF-RT-1`) ──
 * `create()` pushes a pulse through `RealtimeGateway`. `RealtimeModule` imports nothing and is itself
 * a sink, so this module stays acyclic: every edge into it (`LineModule`, `BookingsModule`,
 * `FeedbackModule`, `VenuesModule`) still ends in a sink.
 *
 * ── `APP_INTERCEPTOR` LIVES HERE, NOT IN `configureApp` (C5, R-3) ──
 * `ServerErrorNotificationInterceptor` needs DI (`AdminNotificationTriggers`, `Reflector`), so it is
 * registered as a module-scoped `APP_INTERCEPTOR` provider — active in every e2e app automatically
 * (they boot the real `AppModule`), and it keeps `configureApp` free of feature wiring. This module is
 * `static` — never `forRoot()` — so `AppModule` imports exactly one instance and the interceptor
 * registers exactly once.
 *
 * ── `VersionAnnouncer` (C2) IS A GUARDED PROVIDER, LIKE EVERY CRON (D-6) ──
 * Registered only when `SCHEDULING_ENABLED`, so it is absent from the module graph under jest —
 * `onApplicationBootstrap` never fires in a test run, and `AC-10` holds by construction rather than
 * by a runtime check.
 *
 * ── ONE EXPORT BECOMES TWO ──
 * `NotificationsService` (Phase 1, its `create()`) and now `AdminNotificationTriggers` — the ONLY
 * legal way a Phase 3 domain event reaches the feed (plan B-1).
 */
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: ADMIN_NOTIFICATION_TRIGGERS_ENABLED,
      useFactory: () => schedulingEnabled(process.env),
    },
    AdminNotificationTriggers,
    { provide: APP_INTERCEPTOR, useClass: ServerErrorNotificationInterceptor },
    ...(SCHEDULING_ENABLED ? [VersionAnnouncer] : []),
  ],
  exports: [NotificationsService, AdminNotificationTriggers],
})
export class NotificationsModule {}
