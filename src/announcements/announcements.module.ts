import { Module } from '@nestjs/common';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';

/**
 * `ประกาศและข่าวสาร` — ANNOUNCE-API-1, phase 1: the `Announcement` table and its admin CRUD. Nothing
 * is broadcast (D-1); phase 2 adds the send transition and the LINE push.
 *
 * ── NO IMPORTS ──
 * - **No `PrismaModule`** — it is `@Global()`.
 * - **No `AuthModule`** for `SessionGuard` / `RolesGuard`: both depend only on the global
 *   `PrismaService` and `Reflector`, exactly as in `FeedbackModule` and `BookingsModule`.
 * - **No `LineModule`** — no push in phase 1.
 *
 * Nothing is exported.
 */
@Module({
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
