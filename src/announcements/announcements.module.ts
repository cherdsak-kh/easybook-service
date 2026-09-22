import { Module } from '@nestjs/common';
import { LineModule } from '../line/line.module';
import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';

/**
 * `ประกาศและข่าวสาร` — ANNOUNCE-API-1 (the `Announcement` table and its admin CRUD) and ANNOUNCE-API-2
 * (the LINE send and the OA's bot info).
 *
 * ── IMPORTS ──
 * - **`LineModule`**, for its exported `LineService` (multicast + bot info). Never re-provided here:
 *   there is ONE `LineService` and ONE Messaging client in the app, so a test that replaces
 *   `LINE_MESSAGING_CLIENT` replaces it for every sender. The graph stays acyclic — LineModule
 *   reaches Realtime/Venues and nothing back here.
 * - **No `PrismaModule`** — it is `@Global()`.
 * - **No `AuthModule`** for `SessionGuard` / `RolesGuard`: both depend only on the global
 *   `PrismaService` and `Reflector`, exactly as in `FeedbackModule` and `BookingsModule`.
 *
 * Nothing is exported.
 */
@Module({
  imports: [LineModule],
  controllers: [AnnouncementsController],
  providers: [AnnouncementsService],
})
export class AnnouncementsModule {}
