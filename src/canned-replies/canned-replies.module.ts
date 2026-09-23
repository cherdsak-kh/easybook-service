import { Module } from '@nestjs/common';
import { CannedRepliesController } from './canned-replies.controller';
import { CannedRepliesService } from './canned-replies.service';

/**
 * `ข้อความตอบกลับด่วน` — ANNOUNCE-API-5 (the `CannedReply` table and its admin CRUD).
 *
 * ── NO IMPORTS ──
 * - **No `PrismaModule`** — it is `@Global()`.
 * - **No `AuthModule`** for `SessionGuard` / `RolesGuard`: both depend only on the global
 *   `PrismaService` and `Reflector`, exactly as in `AnnouncementsModule`.
 * - **No `LineModule`**: this module never calls LINE — staff copy the text into the OA console.
 *
 * Nothing is exported.
 */
@Module({
  controllers: [CannedRepliesController],
  providers: [CannedRepliesService],
})
export class CannedRepliesModule {}
