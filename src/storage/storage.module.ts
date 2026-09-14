import { Module } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { SCHEDULING_ENABLED } from '../common/scheduling.constants';
import { OrphanPhotoSweeperCron } from './orphan-photo-sweeper.cron';
import { R2StorageService } from './r2-storage.service';

/**
 * `OrphanPhotoSweeperCron` is registered here, next to the service it calls; `ScheduleModule.forRoot()`
 * is NOT. It moved to `AppModule` when the second, unrelated cron arrived (`BookingExpiryCron`,
 * #ISSUE-06) — exactly the move the previous note here anticipated: one `forRoot()` per app, per-job
 * providers stay in their own modules. Both the root registration and this provider read the single
 * `SCHEDULING_ENABLED` in `common/scheduling.constants.ts`.
 */
const schedulingProviders: Provider[] = SCHEDULING_ENABLED
  ? [OrphanPhotoSweeperCron]
  : [];

/**
 * The object-storage seam. `ConfigModule` is global, so nothing needs importing here.
 * `R2StorageService` is exported so `AuthModule` (the avatar route) resolves the same instance.
 */
@Module({
  providers: [R2StorageService, ...schedulingProviders],
  exports: [R2StorageService],
})
export class StorageModule {}
