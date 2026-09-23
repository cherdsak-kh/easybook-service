import { FeedbackType, Prisma } from '@prisma/client';
import { bangkokDayRange, bookingCodeDatePart } from '../bookings/booking-code';
import {
  FEEDBACK_CODE_PREFIX,
  FEEDBACK_CODE_SEQUENCE_WIDTH,
} from './feedback.constants';

/**
 * The human-readable reference a reporter quotes to staff, and the day boundary it is counted
 * within. Pure functions over a `Date`, so they live here rather than inside `FeedbackService` —
 * `booking-code.ts` states the rule this file follows: a spec for a pure function tests a function,
 * where a spec for the service around it would be testing mocks.
 *
 * ── 🔴 WHAT IS IMPORTED FROM `../bookings/booking-code`, AND WHY IT IS NOT COPIED ──
 * `bookingCodeDatePart` (Bangkok wall clock + Buddhist era) and `bangkokDayRange` (the half-open
 * instant range the sequence is counted over) are IMPORTED, never re-implemented. The two must
 * agree byte for byte or the sequence restarts at 07:00 and mints a duplicate seven hours into
 * every day — that coupling is the whole reason `booking-code.ts` keeps them adjacent, and
 * splitting them across modules is how it breaks. A second copy would also be a second chance for
 * the BE offset or the UTC+7 shift to drift, which is the identical argument `verifyLineIdToken`'s
 * header makes about having one token verifier.
 *
 * Precedent for importing across feature modules: `VenuePhotoUploadService` imports `sniffImageType`
 * from `../storage/image-sniff`, whose comment blesses it — these are pure functions with no Nest
 * DI, no Prisma model and no module import behind them. What is NOT shared is anything carrying
 * user-facing copy or a per-domain limit; those live in `feedback.constants.ts`.
 */

/**
 * `formatFeedbackCode('ISSUE', new Date('2026-09-20T04:00:00Z'), 0)` → `"ISS-25690920-001"`.
 *
 * `sameDayCount` is how many submissions OF THIS TYPE already exist for that Bangkok day; the
 * sequence is the next one. A count above 999 widens the field rather than wrapping — an ugly
 * four-digit reference beats a collision, exactly as `formatBookingCode` documents.
 */
export function formatFeedbackCode(
  type: FeedbackType,
  at: Date,
  sameDayCount: number,
): string {
  const seq = String(sameDayCount + 1).padStart(
    FEEDBACK_CODE_SEQUENCE_WIDTH,
    '0',
  );
  return `${FEEDBACK_CODE_PREFIX[type]}-${bookingCodeDatePart(at)}-${seq}`;
}

/**
 * The next `code` for a submission being written at `now`, counted INSIDE the caller's transaction.
 *
 * ⚠️ COUNTED, NOT RESERVED — see `FEEDBACK_CODE_MAX_ATTEMPTS`, which also records the one hazard
 * bookings does not have (a `Cascade` hard delete of a reporter can drop the day's count).
 *
 * 🔴 THE COUNTER IS SCOPED TO EXACTLY WHAT THE PREFIX IS SCOPED TO. That one sentence explains
 * bookings and feedback at once: `BR` is a single prefix over every booking origin, so
 * `nextBookingCode` counts every request that Bangkok day; `ISS` and `FDB` are two prefixes, so
 * they are two counters, and `ISS-25690920-001` and `FDB-25690920-001` can both exist. Uniqueness
 * does not decide this — the prefix already separates the namespaces — legibility does: a shared
 * counter would print `ISS-…-001` followed by `ISS-…-003`, and the number a reporter reads as "the
 * 3rd issue today" would be a lie told by a suggestion they cannot see.
 *
 * 🔴 THE `where` SHAPE IS FROZEN: `{ type, createdAt: { gte, lt } }` over `bangkokDayRange(now)`,
 * which is exactly what `@@index([type, createdAt])` on `feedbacks` serves.
 */
export async function nextFeedbackCode(
  tx: Prisma.TransactionClient,
  type: FeedbackType,
  now: Date,
): Promise<string> {
  const { start, end } = bangkokDayRange(now);
  const sameDayCount = await tx.feedback.count({
    where: { type, createdAt: { gte: start, lt: end } },
  });
  return formatFeedbackCode(type, now, sameDayCount);
}
