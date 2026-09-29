/**
 * Constants shared by `DashboardService` and `ReportsService` (Reports Phase 1). One file, per the
 * house convention (`bookings.constants.ts`, `venues.constants.ts`): a number two handlers both read
 * belongs in exactly one place, not copied into each.
 */

/** How many PENDING requests `GET /dashboard/vitals` returns in the queue (D-6, prototype `slice(0, 4)`). */
export const DASHBOARD_QUEUE_SIZE = 4;

/**
 * The widest `GET /reports/overview` range, in INCLUSIVE days (D-14). `(endDate − startDate) + 1`
 * must not exceed this. 366 — a leap year — bounds the in-memory fold (§1.2 of the design), never a
 * `$queryRaw`.
 */
export const REPORT_MAX_DAYS = 366;

/**
 * เวลาเปิดให้จองใช้งานจริง (D-10 "held hours"), Bangkok local `HH:mm`. Held-hour clipping only ever
 * counts the overlap of an APPROVED slot with this window, on a school day — never a whole day.
 */
export const SCHOOL_WINDOW_START = { hour: 8, minute: 30 };
export const SCHOOL_WINDOW_END = { hour: 16, minute: 30 };

/**
 * ช่วงปิดภาคฤดูร้อน excluded from `isSchoolDay` (D-10, plan's `isSchoolDay`), inclusive, MM-DD in
 * Bangkok local terms. Fixed calendar rule for Phase 1 — no admin-editable school calendar exists
 * yet (OQ-6, left for the PO).
 */
export const SUMMER_BREAK_START = { month: 4, day: 1 };
export const SUMMER_BREAK_END = { month: 5, day: 15 };

/**
 * เวลาทำการที่หน้าจอแสดงผล (D-3's `withinOperatingHours`), Bangkok local `HH:mm`. WIDER than the
 * school window above — 07:30–16:30 is the prototype's display bound for "is this an off-hours
 * subtitle", not the held-hours accounting window.
 */
export const OPERATING_HOURS_START = { hour: 7, minute: 30 };
export const OPERATING_HOURS_END = { hour: 16, minute: 30 };

/**
 * Hub 1's trend grain default (D-10, prototype `autoGrain`): `MONTH` when the selected range spans
 * MORE than this many days, else `WEEK`.
 */
export const GRAIN_MONTH_THRESHOLD_DAYS = 45;

/** School-day accounting: 8 hours (D-10's `schoolDays × 8 h × venue count` denominator). */
export const SCHOOL_DAY_HOURS = 8;

/**
 * `GET /reports/overview` validation error codes (AC-R15, design §2.5). ONE stable code per
 * condition so the client can branch without parsing English prose.
 */
export const REPORT_ERROR_CODES = [
  'REPORT_DATE_INVALID',
  'REPORT_RANGE_INVERTED',
  'REPORT_RANGE_TOO_WIDE',
  'REPORT_VENUE_INVALID',
  'REPORT_DEPARTMENT_INVALID',
] as const;

export type ReportErrorCode = (typeof REPORT_ERROR_CODES)[number];

export const REPORT_DATE_INVALID_MESSAGE =
  'startDate and endDate must be calendar dates in YYYY-MM-DD form.';
export const REPORT_RANGE_INVERTED_MESSAGE =
  'endDate must not be earlier than startDate.';
export const REPORT_RANGE_TOO_WIDE_MESSAGE = `The date range must not exceed ${REPORT_MAX_DAYS} days.`;
export const REPORT_VENUE_INVALID_MESSAGE =
  'The selected venue is not available.';
export const REPORT_DEPARTMENT_INVALID_MESSAGE =
  'The selected department is not available.';
