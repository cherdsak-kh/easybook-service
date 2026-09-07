import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OrphanPhotoSweeperCron } from './orphan-photo-sweeper.cron';
import { R2StorageService } from './r2-storage.service';

/**
 * Is the nightly sweeper REGISTERED at all?
 *
 * ⚠️ THE GUARD IS ON REGISTRATION, NOT ON THE HANDLER BODY, and the difference is the whole point.
 * `test/e2e-app.ts` boots the REAL `AppModule`, so an unconditional `ScheduleModule.forRoot()` would
 * create a live `CronJob` timer in every one of the e2e suites. An `if (test) return;` inside
 * `sweep()` stops the SWEEP but not the TIMER: the handle stays open, jest reports "a worker process
 * has failed to exit gracefully", and the suite either hangs or is force-killed. Nothing may be
 * registered in the first place.
 *
 * ⚠️ TWO SIGNALS, DELIBERATELY. A bare `NODE_ENV` check FAILS OPEN — unset, `'Test'`, or a trailing
 * space all leave the timer live, and `validateEnv` never requires `NODE_ENV` (the same objection
 * `scripts/hash-password.ts` records against gating a route on it). Both were MEASURED here rather
 * than assumed: under the unit config AND under `test/jest-e2e.json`, jest sets `NODE_ENV="test"` and
 * `JEST_WORKER_ID="1"`. Either one alone would do; together, a jest run that somehow carried a
 * different `NODE_ENV` still registers nothing.
 *
 * Note the direction of the failure: this gate failing open means a timer under test (loud — an open
 * handle), never a missing sweep in production (silent). That is the right way round.
 */
const SCHEDULING_ENABLED =
  process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID === undefined;

/**
 * ⚠️ `ScheduleModule.forRoot()` LIVES HERE, NOT IN `AppModule`, unlike `throttlerModule`.
 *
 * `ThrottlerModule` is app-wide by necessity — it is registered `global: true` so a guard declared in
 * `AuthModule` can resolve its providers. Scheduling needs none of that: `ScheduleModule`'s explorer
 * discovers `@Cron` methods across the whole injector wherever the module is imported, and this repo
 * has exactly one scheduled job, which belongs to the service in this folder. Putting the import next
 * to the only provider that uses it keeps the guard, the job and its justification in one place a
 * reader lands on from `sweepStagedPhotos`; `AppModule` stays a wiring index.
 *
 * If a SECOND unrelated cron ever appears in another module, move `forRoot()` up to `AppModule` then
 * — one `forRoot()` per app — and leave the per-job providers where they are.
 */
const schedulingImports: DynamicModule[] = SCHEDULING_ENABLED
  ? [ScheduleModule.forRoot()]
  : [];

const schedulingProviders: Provider[] = SCHEDULING_ENABLED
  ? [OrphanPhotoSweeperCron]
  : [];

/**
 * The object-storage seam. `ConfigModule` is global, so nothing needs importing here.
 * `R2StorageService` is exported so `AuthModule` (the avatar route) resolves the same instance.
 */
@Module({
  imports: [...schedulingImports],
  providers: [R2StorageService, ...schedulingProviders],
  exports: [R2StorageService],
})
export class StorageModule {}
