import type { PrismaService } from '../prisma/prisma.service';
import {
  CANCEL_LEAD_MINUTES_DEFAULT,
  CANCEL_LEAD_MINUTES_KEY,
} from './bookings.constants';

/**
 * `booking.cancel_lead_minutes`, or the documented default (`Q-C4` ①).
 *
 * ⚠️ A MISSING OR MALFORMED ROW FALLS BACK RATHER THAN THROWING. The seed writes it and a migrated
 * database always has it, but the failure mode of being wrong here is "nobody in the product can
 * cancel anything", and that must not be one bad row away. `value` is a `String` column because
 * `app_settings` is one table for every setting — parsing it is this reader's job.
 *
 * ── EXTRACTED FROM `BookingsService.cancelLeadMinutes()`, VERBATIM (Reports Phase 1) ──
 * `ReportsService` needs the SAME reading for the D-10 late-cancellation window, and a second copy
 * inside `src/reports/` would be a second place for the fallback/parse rule to drift from this one.
 * `BookingsService.cancelLeadMinutes()` now delegates here; its own behaviour is unchanged.
 *
 * Takes `PrismaService` rather than a `Prisma.TransactionClient`: this is a plain read with no
 * write to stay consistent with, so callers outside any transaction (like `ReportsService`) can use
 * it directly.
 */
export async function readCancelLeadMinutes(
  prisma: PrismaService,
): Promise<number> {
  const row = await prisma.appSetting.findUnique({
    where: { key: CANCEL_LEAD_MINUTES_KEY },
    select: { value: true },
  });
  const parsed = Number.parseInt(row?.value ?? '', 10);
  // `>= 0` and not `> 0`: zero is a legitimate configuration meaning "cancel right up to the
  // start". Negative would mean "cancel after it began", which is not a policy, it is a typo.
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : CANCEL_LEAD_MINUTES_DEFAULT;
}
