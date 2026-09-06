/**
 * Orphan venue-photo sweeper — run: `npm run venues:sweep-photos [-- --dry-run --hours=24]`
 *
 * Deletes objects left behind in `venues/_new/` by a CREATE dialog nobody finished. Technical debt
 * "หนี้ 1" of `claude_planning/feature/20260815_2111_admin_portal_v2_build/CHECKLIST.md`; the case for
 * it is in that folder's `NEEDS_DESIGN.md` §`ไฟล์รูปที่ไม่มีแถวชี้`.
 *
 * WHY IT NEVER OPENS THE DATABASE: `D-VN10` made venue photo upload upload-then-bind, so a saved photo
 * is MOVED to `venues/<venueId>/` and no `Venue`/`VenuePhoto` row can point into `venues/_new/`. The
 * whole reasoning lives on `R2StorageService.sweepStagedPhotos`, which is where a reader looking for
 * "where is the cross-check?" will end up. No Prisma here is a design outcome, not an omission.
 *
 * ⚠️ `--hours` HAS A FLOOR OF 1 AND THE FLOOR IS THE POINT. A staged object is also what an open
 * dialog in another tab is holding, and nothing in the bucket distinguishes those two. `--hours=0`
 * turns this script into "delete the photo the operator is looking at". It is refused.
 *
 * Exit codes (this ends up in cron): 0 on a completed sweep INCLUDING one that deleted nothing,
 * 1 on bad arguments, on missing R2 configuration, and on a sweep that threw.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  R2StorageService,
  VENUE_PHOTO_STAGING_PREFIX,
} from '../src/storage/r2-storage.service';

const logger = new Logger('SweepOrphanPhotos');

const USAGE =
  'Usage: npm run venues:sweep-photos -- [--dry-run] [--hours=<number, minimum 1>]';

/** The floor on `--hours`. See the file header — this is the guardrail, not a default. */
export const MIN_HOURS = 1;

/** Matches `STAGED_PHOTO_MIN_AGE_MS`; passed explicitly so the log line can state it. */
export const DEFAULT_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

export interface SweepArgs {
  dryRun: boolean;
  hours: number;
}

/**
 * Parse the argv tail. Exported for the unit spec.
 *
 * ⚠️ AN UNRECOGNISED ARGUMENT IS A HARD ERROR, and that is deliberate: `--dryrun` or `--dry_run`
 * silently ignored would mean the operator asked for a rehearsal and got a real deletion. Throwing on
 * the typo is the only way that mistake stays cheap.
 */
export function parseSweepArgs(args: readonly string[]): SweepArgs {
  let dryRun = false;
  let hours = DEFAULT_HOURS;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg.startsWith('--hours=')) {
      const raw = arg.slice('--hours='.length).trim();
      const parsed = Number(raw);
      // `Number('')` is 0 and `Number(' ')` is 0 — both would sail past a `Number.isFinite` check
      // alone and land as "sweep everything, however new".
      if (raw === '' || !Number.isFinite(parsed)) {
        throw new Error(`--hours must be a number. ${USAGE}`);
      }
      if (parsed < MIN_HOURS) {
        throw new Error(
          `--hours must be at least ${MIN_HOURS} (got ${raw}). A shorter window deletes photos that a venue dialog is still holding open in another tab. ${USAGE}`,
        );
      }
      hours = parsed;
      continue;
    }

    throw new Error(`Unknown argument "${arg}". ${USAGE}`);
  }

  return { dryRun, hours };
}

/**
 * Exported for the unit spec. Sets `process.exitCode` rather than calling `process.exit`, so the log
 * lines flush before the process ends (same reason as `hash-password.ts`).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let args: SweepArgs;
  try {
    args = parseSweepArgs(argv);
  } catch (error: unknown) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const storage = new R2StorageService(new ConfigService());

  // Checked up front so a box without a bucket gets one readable line instead of an SDK stack trace
  // from somewhere three layers down.
  if (!storage.isConfigured()) {
    logger.error(
      'R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_BASE_URL. Nothing was swept.',
    );
    process.exitCode = 1;
    return;
  }

  logger.log(
    `Sweeping ${VENUE_PHOTO_STAGING_PREFIX} for objects older than ${args.hours}h${args.dryRun ? ' — DRY RUN, nothing will be deleted' : ''}.`,
  );

  try {
    const result = await storage.sweepStagedPhotos({
      olderThanMs: args.hours * MS_PER_HOUR,
      dryRun: args.dryRun,
    });
    logger.log(
      `Sweep complete${result.dryRun ? ' (dry run — nothing was deleted)' : ''}. scanned=${result.scannedCount} eligible=${result.eligibleCount} deleted=${result.deletedCount} freedBytes=${result.freedBytes}`,
    );
  } catch (error: unknown) {
    logger.error(
      `Sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    // Without this the SDK's keep-alive sockets hold the event loop open and a cron run hangs after
    // doing its job correctly.
    storage.destroy();
  }
}

// Guarded so the spec can import this module without the CLI firing on require.
if (require.main === module) {
  void main();
}
