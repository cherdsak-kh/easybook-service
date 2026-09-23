import { Prisma } from '@prisma/client';
import {
  BANGKOK_UTC_OFFSET_MINUTES,
  BOOKING_CODE_PREFIX,
  BOOKING_CODE_SEQUENCE_WIDTH,
  BUDDHIST_ERA_OFFSET,
} from './bookings.constants';

/**
 * The human-readable booking number, and the day boundary it is counted within.
 *
 * Both live here rather than inside `BookingsService` because they are pure functions over a
 * `Date`, and `CONVENTIONS.md` §2's rule applies in this repo too: a spec for a pure function tests
 * a function, which is worth doing, where a spec for the service around it would be testing mocks.
 */

/**
 * The Bangkok wall-clock calendar day `at` falls on, as a `Date` shifted into that frame.
 *
 * ⚠️ THE RETURN VALUE IS A LIE ABOUT ITS OWN INSTANT and must never be stored. It is a `Date` whose
 * UTC fields read as Bangkok's local fields, which is the only way to ask `getUTCFullYear()` for
 * "the year it is in Thailand" without a time-zone database. Use it to READ calendar fields and
 * throw it away; every column in this schema stores real instants.
 */
function inBangkok(at: Date): Date {
  return new Date(at.getTime() + BANGKOK_UTC_OFFSET_MINUTES * 60_000);
}

/** `2026-09-02T17:00:00Z` → `"25690903"` (03:00 on the 3rd, Bangkok). */
export function bookingCodeDatePart(at: Date): string {
  const local = inBangkok(at);
  const year = local.getUTCFullYear() + BUDDHIST_ERA_OFFSET;
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * The half-open instant range `[start, end)` of the Bangkok calendar day containing `at`.
 *
 * This is what the per-day sequence is counted over, and it MUST agree with
 * {@link bookingCodeDatePart}: counting over a UTC day while labelling with a Bangkok one would
 * restart the sequence at 07:00 every morning and mint a duplicate `code` seven hours into each day.
 */
export function bangkokDayRange(at: Date): { start: Date; end: Date } {
  const local = inBangkok(at);
  const midnightLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const start = new Date(midnightLocal - BANGKOK_UTC_OFFSET_MINUTES * 60_000);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * `formatBookingCode(new Date('2026-09-02T04:00:00Z'), 0)` → `"BR-25690902-001"`.
 *
 * `sameDayCount` is how many requests already exist for that Bangkok day; the sequence is the next
 * one. A count above 999 widens the field rather than wrapping — a 1000th booking in one day should
 * produce an ugly code, never a collision.
 */
export function formatBookingCode(at: Date, sameDayCount: number): string {
  const seq = String(sameDayCount + 1).padStart(
    BOOKING_CODE_SEQUENCE_WIDTH,
    '0',
  );
  return `${BOOKING_CODE_PREFIX}-${bookingCodeDatePart(at)}-${seq}`;
}

/**
 * The next `code` for a request being written at `now`, counted INSIDE the caller's transaction.
 *
 * ⚠️ COUNTED, NOT RESERVED — see `BOOKING_CODE_MAX_ATTEMPTS`. Two requests written in the same
 * instant compute the same number, the loser takes a `P2002`, and the fix is to run the whole
 * transaction again so the count sees the row that beat it. The counter is over EVERY request created
 * that Bangkok day, admin direct bookings included, which only ever skips a number.
 *
 * 🔴 THE `where` SHAPE IS FROZEN: `{ createdAt: { gte, lt } }` over `bangkokDayRange(now)`. Both the
 * LIFF path and the admin direct path mint codes from this one function so a single day's sequence
 * cannot fork into two counters that each think they are authoritative.
 */
export async function nextBookingCode(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<string> {
  const { start, end } = bangkokDayRange(now);
  const sameDayCount = await tx.bookingRequest.count({
    where: { createdAt: { gte: start, lt: end } },
  });
  return formatBookingCode(now, sameDayCount);
}

/**
 * A `P2002` naming the `code` column — the only unique constraint a booking create can trip.
 *
 * ⚠️ IT MUST NOT WIDEN. An exclusion violation (`23P01`) is a DIFFERENT failure with a different
 * answer: retrying it just loses the same race again, and the caller owes the client a `409`. That
 * separation is why this checks the error code AND the target column rather than "something was
 * unique-ish".
 */
export function isCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes('code') : target === 'code';
}
