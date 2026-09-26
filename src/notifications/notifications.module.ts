import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * `การแจ้งเตือน` — `NOTIF-API-1`, phase 1: the `AdminNotification` feed and each operator's private
 * read/dismiss state (`AdminNotificationReceipt`), behind `/notifications`.
 *
 * ── NO IMPORTS ──
 * - **No `PrismaModule`** — it is `@Global()`.
 * - **No `AuthModule`** for `SessionGuard` / `RolesGuard`: both depend only on the global
 *   `PrismaService` and `Reflector`, exactly as in `AnnouncementsModule` and `FeedbackModule`.
 *
 * ── ONE EXPORT ──
 * `NotificationsService`, for its `create()` — the ONLY way a notification is authored (D-4). Phase 3's
 * domain-event listeners (`NOTIF-EVENTS-1`) import this module for it. No module imports it yet.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
