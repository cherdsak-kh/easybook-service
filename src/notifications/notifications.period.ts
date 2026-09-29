import { bangkokDayRange } from '../bookings/booking-code';
import type { NotificationPeriod } from './notifications.constants';

const DAY_MS = 86_400_000;

/** How many whole Bangkok days before today each period reaches back. */
const DAYS_BACK: Record<NotificationPeriod, number> = {
  today: 0,
  '7d': 7,
  '30d': 30,
};

/**
 * The inclusive lower bound on `createdAt` for a `period` filter, or `null` for "all time" (D-5).
 *
 * `today` is Bangkok midnight today; `7d` / `30d` are Bangkok midnight of today − 7 / − 30 days. That
 * matches the prototype exactly: its filter is `days ≤ N` on whole calendar days ago, so "7 วันที่ผ่านมา"
 * is today plus the seven days before it.
 *
 * ⚠️ `bangkokDayRange` is REUSED, never re-derived: the container clock is UTC, so a naive
 * `setHours(0)` would cut "today" at 07:00 Bangkok time. Bangkok has no DST, so subtracting whole days
 * from its midnight is exact.
 *
 * `now` is a parameter so the unit test can inject the clock (AC-8).
 */
export function periodFloor(
  period: NotificationPeriod | undefined,
  now: Date = new Date(),
): Date | null {
  if (period === undefined) return null;
  const { start } = bangkokDayRange(now);
  return new Date(start.getTime() - DAYS_BACK[period] * DAY_MS);
}
