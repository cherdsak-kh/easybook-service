import { BANGKOK_UTC_OFFSET_MINUTES } from '../bookings/bookings.constants';
import {
  GRAIN_MONTH_THRESHOLD_DAYS,
  OPERATING_HOURS_END,
  OPERATING_HOURS_START,
  SCHOOL_WINDOW_END,
  SCHOOL_WINDOW_START,
  SUMMER_BREAK_END,
  SUMMER_BREAK_START,
} from './reports.constants';

/**
 * Pure Bangkok-calendar arithmetic for Reports Phase 1 (design §2.1, §1.3). No I/O, no Nest, no
 * ambient clock — every function takes what it needs as an argument, which is what makes it
 * testable under `TZ=UTC` AND `TZ=Asia/Bangkok` alike (AC-R16): nothing here ever calls a local
 * `Date` getter (`getHours`, `getDate`, …), only UTC fields of an instant already shifted by the
 * fixed +07:00 offset.
 *
 * Calendar DATES are represented as plain `YYYY-MM-DD` strings throughout — never as a `Date` whose
 * time-of-day carries no meaning. String comparison (`<`, `>`) on this exact format is a correct
 * lexicographic date order, and every helper below relies on that rather than re-parsing to compare.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Guards `splitAndClip`/`schoolDaysIn` against a runaway loop on malformed input (§1.3 scale note). */
const MAX_SPAN_DAYS = 3660;

interface DateParts {
  year: number;
  month: number; // 1–12
  day: number;
}

/** `at` shifted so its UTC fields read as Bangkok's local fields. Never store the result. */
function inBangkok(at: Date): Date {
  return new Date(at.getTime() + BANGKOK_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** `2026-09-02T17:00:00Z` → `"2026-09-03"` (00:00 UTC+7 the next day). */
export function bangkokDate(at: Date): string {
  const local = inBangkok(at);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Strict `YYYY-MM-DD` parse with a round trip through `Date.UTC`, so `2026-02-30` (a real string,
 * not a real date) is rejected rather than silently rolling over to March.
 */
function parseDateStrict(dateStr: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function requireDate(dateStr: string): DateParts {
  const parts = parseDateStrict(dateStr);
  if (!parts) throw new Error(`Invalid Bangkok calendar date: ${dateStr}`);
  return parts;
}

/** `null` for anything that is not a real `YYYY-MM-DD` calendar date — the AC-R15 `#2` gate. */
export function parseReportDate(dateStr: string): string | null {
  return parseDateStrict(dateStr) ? dateStr : null;
}

/** The real UTC instant of `dateStr`'s Bangkok midnight — the same construction as `bangkokDayRange`. */
export function dayStart(dateStr: string): Date {
  const { year, month, day } = requireDate(dateStr);
  const midnightLocal = Date.UTC(year, month - 1, day);
  return new Date(midnightLocal - BANGKOK_UTC_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** `dateStr` shifted by `n` (possibly negative) calendar days. Pure calendar math — no time zone. */
export function addDays(dateStr: string, n: number): string {
  const { year, month, day } = requireDate(dateStr);
  const shifted = new Date(Date.UTC(year, month - 1, day + n));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Inclusive day count of `[fromStr, toStr]`. Negative range (`from > to`) is not a valid call. */
export function inclusiveDays(fromStr: string, toStr: string): number {
  return (
    Math.round(
      (dayStart(toStr).getTime() - dayStart(fromStr).getTime()) / MS_PER_DAY,
    ) + 1
  );
}

/**
 * Bangkok calendar days from `fromStr` to `toStr`. Negative when `toStr` precedes `fromStr` — the
 * D-6 badge rule's `<0 overdue, 0 today, 1 tomorrow`.
 */
export function dayOffset(fromStr: string, toStr: string): number {
  return Math.round(
    (dayStart(toStr).getTime() - dayStart(fromStr).getTime()) / MS_PER_DAY,
  );
}

/** Lexicographic compare on `YYYY-MM-DD`, which is a correct date order for this exact format. */
function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ISO weekday of a Bangkok calendar date: `0` = Sunday … `6` = Saturday. */
function weekdayOf({ year, month, day }: DateParts): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Mon–Fri, excluding the fixed summer break (D-10's `isSchoolDay`: 1 Apr – 15 May inclusive, every
 * year, month/day only — no admin-editable school calendar exists yet, OQ-6).
 */
export function isSchoolDay(dateStr: string): boolean {
  const parts = requireDate(dateStr);
  const weekday = weekdayOf(parts);
  if (weekday === 0 || weekday === 6) return false;
  const afterBreakStart =
    parts.month > SUMMER_BREAK_START.month ||
    (parts.month === SUMMER_BREAK_START.month &&
      parts.day >= SUMMER_BREAK_START.day);
  const beforeBreakEnd =
    parts.month < SUMMER_BREAK_END.month ||
    (parts.month === SUMMER_BREAK_END.month &&
      parts.day <= SUMMER_BREAK_END.day);
  return !(afterBreakStart && beforeBreakEnd);
}

/** Count of school days in `[fromStr, toStr]` inclusive. `0` when `fromStr > toStr`. */
export function schoolDaysIn(fromStr: string, toStr: string): number {
  if (compareDate(fromStr, toStr) > 0) return 0;
  if (inclusiveDays(fromStr, toStr) > MAX_SPAN_DAYS) {
    throw new Error(
      'schoolDaysIn: range too wide — caller must enforce REPORT_MAX_DAYS first.',
    );
  }
  let count = 0;
  let cur = fromStr;
  while (compareDate(cur, toStr) <= 0) {
    if (isSchoolDay(cur)) count += 1;
    cur = addDays(cur, 1);
  }
  return count;
}

function windowInstant(
  dateStr: string,
  hm: { hour: number; minute: number },
): Date {
  return new Date(
    dayStart(dateStr).getTime() + (hm.hour * 60 + hm.minute) * MS_PER_MINUTE,
  );
}

/**
 * The `slot`'s held hours inside `[fromStr, toStr]`, split per Bangkok day and clipped to
 * 08:30–16:30 on school days only (D-10, AC-R6). A slot fully or partly outside a school day, or
 * outside `[fromStr, toStr]`, contributes `0` for those days — never negative, never counted twice.
 *
 * Cross-midnight slots (E-6) are handled by construction: the loop walks every Bangkok day the slot
 * TOUCHES, from `bangkokDate(startAt)` to `bangkokDate(endAt − 1ms)` (half-open — an instant exactly
 * at `endAt` is not "in" the slot), and each day's contribution is clipped independently.
 */
export function splitAndClip(
  slot: { startAt: Date; endAt: Date },
  fromStr: string,
  toStr: string,
): number {
  if (compareDate(fromStr, toStr) > 0) return 0;
  if (slot.endAt.getTime() <= slot.startAt.getTime()) return 0;

  const startDay = bangkokDate(slot.startAt);
  const endDay = bangkokDate(new Date(slot.endAt.getTime() - 1));
  if (inclusiveDays(startDay, endDay) > MAX_SPAN_DAYS) {
    throw new Error('splitAndClip: slot spans an implausible number of days.');
  }

  let totalMs = 0;
  let cur = startDay;
  while (compareDate(cur, endDay) <= 0) {
    if (
      compareDate(cur, fromStr) >= 0 &&
      compareDate(cur, toStr) <= 0 &&
      isSchoolDay(cur)
    ) {
      const winStart = windowInstant(cur, SCHOOL_WINDOW_START).getTime();
      const winEnd = windowInstant(cur, SCHOOL_WINDOW_END).getTime();
      const clipStart = Math.max(slot.startAt.getTime(), winStart);
      const clipEnd = Math.min(slot.endAt.getTime(), winEnd);
      if (clipEnd > clipStart) totalMs += clipEnd - clipStart;
    }
    cur = addDays(cur, 1);
  }
  return totalMs / 3_600_000;
}

/** One clipped calendar bucket. `partial` = the bucket's natural span was cut by `[fromStr, toStr]`. */
export interface CalendarBucket {
  from: string;
  to: string;
  partial: boolean;
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the NEXT month is the last day of THIS month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Calendar months overlapping `[fromStr, toStr]`, oldest first, each clipped to the range
 * (D-10 trend, AC-R9). Empty when `fromStr > toStr`.
 */
export function monthBuckets(fromStr: string, toStr: string): CalendarBucket[] {
  if (compareDate(fromStr, toStr) > 0) return [];
  const buckets: CalendarBucket[] = [];
  let { year, month } = requireDate(fromStr);
  // Bound the loop the same way REPORT_MAX_DAYS bounds the caller — 366 days spans at most 13
  // calendar months, so 400 is a generous, unreachable-in-practice ceiling.
  for (let i = 0; i < 400; i += 1) {
    const pad = String(month).padStart(2, '0');
    const monthStart = `${year}-${pad}-01`;
    const monthEnd = `${year}-${pad}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
    const bucketFrom =
      compareDate(monthStart, fromStr) < 0 ? fromStr : monthStart;
    const bucketTo = compareDate(monthEnd, toStr) > 0 ? toStr : monthEnd;
    buckets.push({
      from: bucketFrom,
      to: bucketTo,
      partial: bucketFrom !== monthStart || bucketTo !== monthEnd,
    });
    if (compareDate(monthEnd, toStr) >= 0) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return buckets;
}

/**
 * Mon–Sun weeks overlapping `[fromStr, toStr]`, oldest first, each clipped to the range (D-10
 * trend, AC-R9). Empty when `fromStr > toStr`.
 */
export function weekBuckets(fromStr: string, toStr: string): CalendarBucket[] {
  if (compareDate(fromStr, toStr) > 0) return [];
  const parts = requireDate(fromStr);
  const weekday = weekdayOf(parts); // 0=Sun..6=Sat
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  let weekStart = addDays(fromStr, -daysSinceMonday);

  const buckets: CalendarBucket[] = [];
  // 366 days spans at most 54 ISO weeks; 600 is a generous ceiling well short of MAX_SPAN_DAYS/7.
  for (let i = 0; i < 600; i += 1) {
    const weekEnd = addDays(weekStart, 6);
    const bucketFrom =
      compareDate(weekStart, fromStr) < 0 ? fromStr : weekStart;
    const bucketTo = compareDate(weekEnd, toStr) > 0 ? toStr : weekEnd;
    buckets.push({
      from: bucketFrom,
      to: bucketTo,
      partial: bucketFrom !== weekStart || bucketTo !== weekEnd,
    });
    if (compareDate(weekEnd, toStr) >= 0) break;
    weekStart = addDays(weekStart, 7);
  }
  return buckets;
}

/** D-10's `autoGrain`: `MONTH` once the selected range exceeds {@link GRAIN_MONTH_THRESHOLD_DAYS}. */
export function defaultTrendGrain(days: number): 'MONTH' | 'WEEK' {
  return days > GRAIN_MONTH_THRESHOLD_DAYS ? 'MONTH' : 'WEEK';
}

/** Minutes since Bangkok local midnight, `0`–`1439`. Exported for `dashboard-rooms.ts`'s D-3 rule. */
export function bangkokMinutesOfDay(at: Date): number {
  const local = inBangkok(at);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/**
 * D-3's `withinOperatingHours`: Mon–Fri, 07:30–16:30 Bangkok, inclusive of both ends. Ignores
 * public holidays and the summer break (OQ-A1) — a DISPLAY bound for the subtitle, distinct from
 * the school-day accounting window above.
 */
export function isOperatingTime(at: Date): boolean {
  const dateStr = bangkokDate(at);
  const weekday = weekdayOf(requireDate(dateStr));
  if (weekday === 0 || weekday === 6) return false;
  const minutes = bangkokMinutesOfDay(at);
  const startMin =
    OPERATING_HOURS_START.hour * 60 + OPERATING_HOURS_START.minute;
  const endMin = OPERATING_HOURS_END.hour * 60 + OPERATING_HOURS_END.minute;
  return minutes >= startMin && minutes <= endMin;
}
