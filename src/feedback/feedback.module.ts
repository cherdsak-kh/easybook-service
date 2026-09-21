import { Module } from '@nestjs/common';
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import { StorageModule } from '../storage/storage.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackPhotoService } from './feedback-photo.service';
import { FeedbackService } from './feedback.service';

/**
 * `CLIENT-ISSUE-1` — แจ้งปัญหา / ข้อเสนอแนะ. Two write routes and nothing else: there is no admin
 * read/list/triage surface, no status transition, no "my submissions" list and no notification in
 * this cycle.
 *
 * ── ONE IMPORT, AND TWO ABSENCES ──
 * - **`StorageModule`** — for `R2StorageService`, exactly as `VenuesModule` imports it. Both
 *   services need it: the upload writes the object, and the submit reads `publicBaseUrl()` to
 *   refuse a photo URL this deployment did not mint.
 * - **No `PrismaModule`** — it is `@Global()`.
 * - **No `LineModule`, even though both routes use `LineIdTokenGuard`.** That module does not
 *   export the guard, and importing it for one guard would drag `RealtimeModule` and `VenuesModule`
 *   in behind it and make this module's dependency graph a lie about what it needs — the reasoning
 *   `BookingsModule` writes out. `LineIdTokenGuard` depends only on the global `ConfigService`, so
 *   a second instance costs nothing and shares no state: it is a pure verifier holding no cache and
 *   no connection, and the token check itself lives in ONE free function either way
 *   (`verifyLineIdToken`).
 *
 * Nothing is exported: no other module has any business writing a submission.
 */
@Module({
  imports: [StorageModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackPhotoService, LineIdTokenGuard],
})
export class FeedbackModule {}
