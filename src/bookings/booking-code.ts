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
