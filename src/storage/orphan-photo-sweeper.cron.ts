import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  R2StorageService,
  STAGED_PHOTO_MIN_AGE_MS,
  VENUE_PHOTO_STAGING_PREFIX,
} from './r2-storage.service';

/**
 * Daily at 03:00, server local time. Five-field form — minute 0, hour 3, every day.
 *
 * Exported so the spec asserts the EXACT string rather than re-typing it, which is the only way a
 * fat-fingered `'0 3 * * *'` → `'0 3 * * 0'` (weekly) is caught: both are valid cron and neither
 * throws. Equivalent to `CronExpression.EVERY_DAY_AT_3AM` (`'0 03 * * *'`); written out because a
 * literal is what the spec can compare against.
 *
 * ⚠️ NO TIMEZONE IS PASSED, so this follows the host's `TZ`. 03:00 is chosen for the property that
 * survives a timezone mistake anyway: it is outside working hours in every timezone this school
 * would deploy in, and the job only touches objects older than 24h — so even a run at the wrong
 * hour deletes nothing an operator could still be holding.
 */
export const ORPHAN_PHOTO_SWEEP_CRON = '0 3 * * *';

/**
 * The automated half of `npm run venues:sweep-photos`.
 *
 * The CLI works but somebody has to remember to run it, and abandoned `venues/_new/` objects leak
 * R2 storage forever until they do. Scheduling it IN-APP rather than in a host crontab keeps the
 * job, its window and its logs inside the deployable — a `docker-compose.staging.yml` that ships one
 * app container has nowhere to put a crontab, and a cron entry on the host is invisible to anyone
 * reading this repo.
 *
 * ⚠️ THIS IS NOT A SECOND IMPLEMENTATION. It calls the same `sweepStagedPhotos` the CLI calls, with
 * the same default window; the CLI keeps `--dry-run`/`--hours` for the ad-hoc case. If the sweep
 * rule ever changes it changes in `R2StorageService`, once.
 *
 * ⚠️ IT DOES NOT CALL `storage.destroy()`. The CLI must, so a one-shot process can exit; a
 * long-running server wants exactly the opposite — killing the SDK's keep-alive sockets nightly
 * would just make the next avatar upload pay a fresh TLS handshake. See that method's own note.
 */
@Injectable()
export class OrphanPhotoSweeperCron {
  private readonly logger = new Logger(OrphanPhotoSweeperCron.name);

  constructor(private readonly storage: R2StorageService) {}

  /**
   * ⚠️ NOTHING MAY ESCAPE THIS METHOD. An unhandled rejection out of a `CronJob` tick is not a failed
   * request that returns a 500 — there is no request. Node reports it as an unhandled rejection,
   * which on Node 20+ terminates the process by default, so a transient R2 blip at 03:00 would take
   * the API down until the container restarted. A sweep that fails is a logged warning and a retry
   * tomorrow; it is never worth the server.
   */
  @Cron(ORPHAN_PHOTO_SWEEP_CRON)
  async sweep(): Promise<void> {
    // Checked first so a dev box (or any deploy without a bucket) gets one readable line a day
    // instead of a nightly STORAGE_NOT_CONFIGURED error from three layers down. Production cannot
    // reach this branch — `validateEnv` requires all five R2 vars there.
    if (!this.storage.isConfigured()) {
      this.logger.warn(
        `R2 is not configured — skipping the nightly ${VENUE_PHOTO_STAGING_PREFIX} sweep.`,
      );
      return;
    }

    try {
      const result = await this.storage.sweepStagedPhotos({
        olderThanMs: STAGED_PHOTO_MIN_AGE_MS,
      });
      this.logger.log(
        `Nightly staged-photo sweep finished. scanned=${result.scannedCount} eligible=${result.eligibleCount} deleted=${result.deletedCount} freedBytes=${result.freedBytes}`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Nightly staged-photo sweep failed; the objects stay eligible for tomorrow's run. reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
