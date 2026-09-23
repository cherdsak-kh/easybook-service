import { Module } from '@nestjs/common';
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import { StorageModule } from '../storage/storage.module';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminFeedbackService } from './admin-feedback.service';
import { FeedbackController } from './feedback.controller';
import { FeedbackPhotoService } from './feedback-photo.service';
import { FeedbackService } from './feedback.service';

/**
 * แจ้งปัญหา / ข้อเสนอแนะ — both halves of the feedback domain, the `BookingsModule` precedent of one
 * module hosting a LIFF controller and an admin controller over the same table.
 *
 * - **`CLIENT-ISSUE-1` (LIFF)** — `FeedbackController`, `/line-users/feedback` and `…/photos`: two
 *   bearer-authenticated, CSRF-exempt write routes. A reporter submits; they never read a status, a
 *   log or a list of their own submissions.
 * - **`ADMIN-FEEDBACK-1` (back office)** — `AdminFeedbackController`, `/feedback`: list, detail and
 *   the PATCH that owns every `Feedback.status` transition and appends the `FeedbackLog` audit trail.
 *   Cookie session + CSRF, `@Roles` per method (VIEWER reads, SUPER_ADMIN/ADMIN write). No
 *   notification to the reporter and no realtime event.
 *
 * ── ONE IMPORT, AND THREE ABSENCES ──
 * - **`StorageModule`** — for `R2StorageService`, exactly as `VenuesModule` imports it. Both LIFF
 *   services need it: the upload writes the object, and the submit reads `publicBaseUrl()` to
 *   refuse a photo URL this deployment did not mint. The admin half never touches it — photo URLs
 *   are public and rendered directly (D-7).
 * - **No `PrismaModule`** — it is `@Global()`.
 * - **No `AuthModule`** for `SessionGuard` / `RolesGuard`: both depend only on the global
 *   `PrismaService` and `Reflector`, exactly as in `BookingsModule`.
 * - **No `LineModule`, even though both LIFF routes use `LineIdTokenGuard`.** That module does not
 *   export the guard, and importing it for one guard would drag `RealtimeModule` and `VenuesModule`
 *   in behind it and make this module's dependency graph a lie about what it needs — the reasoning
 *   `BookingsModule` writes out. `LineIdTokenGuard` depends only on the global `ConfigService`, so
 *   a second instance costs nothing and shares no state: it is a pure verifier holding no cache and
 *   no connection, and the token check itself lives in ONE free function either way
 *   (`verifyLineIdToken`).
 *
 * Nothing is exported: no other module has any business writing a submission or triaging one.
 */
@Module({
  imports: [StorageModule],
  controllers: [FeedbackController, AdminFeedbackController],
  providers: [
    FeedbackService,
    FeedbackPhotoService,
    AdminFeedbackService,
    LineIdTokenGuard,
  ],
})
export class FeedbackModule {}
