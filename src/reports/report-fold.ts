import { BadRequestException } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import {
  addDays,
  bangkokDate,
  dayStart,
  HOUR_MS,
  inclusiveDays,
  parseReportDate,
  schoolDaysIn,
  splitAndClipMs,
} from './report-calendar';
import type {
  DisciplineDto,
  OccupancyDto,
  ReportRangeDto,
  RequestBreakdownDto,
} from './dto/reports-overview-response.dto';
import {
  REPORT_DATE_INVALID_MESSAGE,
  REPORT_MAX_DAYS,
  REPORT_RANGE_INVERTED_MESSAGE,
  REPORT_RANGE_TOO_WIDE_MESSAGE,
  SCHOOL_DAY_HOURS,
  type ReportErrorCode,
} from './reports.constants';

/**
 * The shared fold (design §2.1, §2.1.2) — extracted from `reports.service.ts` (Reports Phase 1) so
 * `/reports/overview`, `/reports/venues` and `/reports/operations` all compute their populations and
 * their pure aggregates through ONE set of functions. Nothing here does I/O; every Prisma read stays
 * in `reports.service.ts`.
 */

export { HOUR_MS };

/** Wraps `IntegrationsService`'s `codedError()` shape (same convention, moved here Phase 2). */
export function codedError(
  code: ReportErrorCode,
  message: string,
): BadRequestException {
  const base = new BadRequestException(message).getResponse() as Record<
    string,
    unknown
  >;
  return new BadRequestException({ ...base, code });
}

export function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const minDate = (a: string, b: string): string =>
  compareDate(a, b) <= 0 ? a : b;

export interface ReportRange {
  startDate: string;
  endDate: string;
  days: number;
}

/**
 * 400 `REPORT_DATE_INVALID` → `REPORT_RANGE_INVERTED` → `REPORT_RANGE_TOO_WIDE`, in that order
 * (design §2.4, P1 §2.5 rows 2–4). Shared by all three report endpoints.
 */
export function parseReportRange(
  startRaw: string,
  endRaw: string,
): ReportRange {
  const startDate = parseReportDate(startRaw);
  const endDate = parseReportDate(endRaw);
  if (!startDate || !endDate) {
    throw codedError('REPORT_DATE_INVALID', REPORT_DATE_INVALID_MESSAGE);
  }
  if (compareDate(startDate, endDate) > 0) {
    throw codedError('REPORT_RANGE_INVERTED', REPORT_RANGE_INVERTED_MESSAGE);
  }
  const days = inclusiveDays(startDate, endDate);
  if (days > REPORT_MAX_DAYS) {
    throw codedError('REPORT_RANGE_TOO_WIDE', REPORT_RANGE_TOO_WIDE_MESSAGE);
  }
  return { startDate, endDate, days };
}

export interface ReportWindow extends ReportRange {
  serverTime: Date;
  /** Bangkok yesterday at `serverTime`. Data stops here (D-10). */
  dataUntilDate: string;
  /** `min(endDate, dataUntilDate)`; `null` when the range is entirely in the future (E-13). */
  effectiveEndDate: string | null;
  /** `0` when `effectiveEndDate` is `null`. */
  schoolDays: number;
}

/** The narrowed form once `effectiveEndDate` is known non-null — carries the query bounds too. */
export type OpenReportWindow = ReportWindow & {
  effectiveEndDate: string;
  S: Date;
  E: Date;
};

/** Builds the window for `range` as of `now`. Pure — the caller supplies the clock (AC-R16). */
export function reportWindowAt(
  range: ReportRange,
  now: Date,
): ReportWindow | OpenReportWindow {
  const today = bangkokDate(now);
  const dataUntilDate = addDays(today, -1);
  const effectiveEndDateRaw = minDate(range.endDate, dataUntilDate);
  const isEmpty = compareDate(range.startDate, effectiveEndDateRaw) > 0;
  if (isEmpty) {
    return {
      ...range,
      serverTime: now,
      dataUntilDate,
      effectiveEndDate: null,
      schoolDays: 0,
    };
  }
  const schoolDays = schoolDaysIn(range.startDate, effectiveEndDateRaw);
  const S = dayStart(range.startDate);
  const E = dayStart(addDays(effectiveEndDateRaw, 1));
  return {
    ...range,
    serverTime: now,
    dataUntilDate,
    effectiveEndDate: effectiveEndDateRaw,
    schoolDays,
    S,
    E,
  };
}

/** Type guard: `w.effectiveEndDate !== null`, i.e. there is a non-empty window to query. */
export function isOpen(w: ReportWindow): w is OpenReportWindow {
  return w.effectiveEndDate !== null;
}

export function rangeDtoOf(
  w: ReportWindow,
  dataStartDate: string | null,
): ReportRangeDto {
  return {
    startDate: w.startDate,
    endDate: w.endDate,
    dataUntilDate: w.dataUntilDate,
    effectiveEndDate: w.effectiveEndDate,
    days: w.days,
    schoolDays: w.schoolDays,
    dataStartDate,
  };
}

/** THE attributed-request population (design §1.2, §2.1.2). Every hub's request read is this. */
export function attributedRequestWhere(
  w: OpenReportWindow,
  extra: Prisma.BookingRequestWhereInput = {},
): Prisma.BookingRequestWhereInput {
  return {
    firstStartAt: { gte: w.S, lt: w.E },
    ...extra,
  } satisfies Prisma.BookingRequestWhereInput;
}

/** THE held-slot population (design §1.2, §2.1.2). Every hub's held-hours read is this. */
export function heldSlotWhere(
  w: OpenReportWindow,
  slotExtra: Prisma.BookingSlotWhereInput = {},
  requestExtra: Prisma.BookingRequestWhereInput = {},
): Prisma.BookingSlotWhereInput {
  return {
    isCancelled: false,
    startAt: { lt: w.E },
    endAt: { gt: w.S },
    ...slotExtra,
    bookingRequest: { status: BookingStatus.APPROVED, ...requestExtra },
  } satisfies Prisma.BookingSlotWhereInput;
}

export interface DayCounts {
  total: number;
  approved: number;
  rejected: number;
  autoRejected: number;
  cancelled: number;
  expired: number;
  pending: number;
}

export function emptyDayCounts(): DayCounts {
  return {
    total: 0,
    approved: 0,
    rejected: 0,
    autoRejected: 0,
    cancelled: 0,
    expired: 0,
    pending: 0,
  };
}

export function sumDailyCounts(
  dailyCounts: Map<string, DayCounts>,
  from: string,
  to: string,
): DayCounts {
  const acc = emptyDayCounts();
  for (const [date, counts] of dailyCounts) {
    if (date < from || date > to) continue;
    acc.total += counts.total;
    acc.approved += counts.approved;
    acc.rejected += counts.rejected;
    acc.autoRejected += counts.autoRejected;
    acc.cancelled += counts.cancelled;
    acc.expired += counts.expired;
    acc.pending += counts.pending;
  }
  return acc;
}

/** Bucket school days, clipped to `effectiveEndDate` (design §2.5: "counted up to effectiveEndDate"). */
export function clippedSchoolDays(
  bucketFrom: string,
  bucketTo: string,
  effectiveEndDate: string | null,
): number {
  if (!effectiveEndDate) return 0;
  if (compareDate(bucketFrom, effectiveEndDate) > 0) return 0;
  const clippedTo =
    compareDate(bucketTo, effectiveEndDate) > 0 ? effectiveEndDate : bucketTo;
  return schoolDaysIn(bucketFrom, clippedTo);
}

/** `rejectReason === AUTO_REJECTED_REASON` on a REJECTED row (ADR-001 marker, R-1/R-2, D-13). */
export function isAutoRejected(r: {
  status: BookingStatus;
  rejectReason: string | null;
}): boolean {
  return (
    r.status === BookingStatus.REJECTED &&
    r.rejectReason === AUTO_REJECTED_REASON
  );
}

/** Folds an attributed-request array into total + per-day `DayCounts` (design §2.1.2). */
export function foldStatusCounts<
  R extends {
    status: BookingStatus;
    rejectReason: string | null;
    firstStartAt: Date;
  },
>(rows: readonly R[]): { counts: DayCounts; daily: Map<string, DayCounts> } {
  const counts = emptyDayCounts();
  const daily = new Map<string, DayCounts>();
  for (const row of rows) {
    counts.total += 1;
    const date = bangkokDate(row.firstStartAt);
    const day = daily.get(date) ?? emptyDayCounts();
    day.total += 1;

    switch (row.status) {
      case BookingStatus.APPROVED:
        counts.approved += 1;
        day.approved += 1;
        break;
      case BookingStatus.REJECTED:
        counts.rejected += 1;
        day.rejected += 1;
        if (isAutoRejected(row)) {
          counts.autoRejected += 1;
          day.autoRejected += 1;
        }
        break;
      case BookingStatus.CANCELLED:
        counts.cancelled += 1;
        day.cancelled += 1;
        break;
      case BookingStatus.EXPIRED:
        counts.expired += 1;
        day.expired += 1;
        break;
      case BookingStatus.PENDING:
        counts.pending += 1;
        day.pending += 1;
        break;
    }
    daily.set(date, day);
  }
  return { counts, daily };
}

/**
 * The OQ-2 (P1 PO ruling) breakdown: every one of the five mutually-exclusive statuses gets both a
 * count and an unrounded `*Percent`, summing to exactly 100 whenever `total > 0` — true BY
 * CONSTRUCTION, because the five counts already sum to `total`.
 */
export function requestBreakdownOf(c: DayCounts): RequestBreakdownDto {
  const pctOf = (count: number): number =>
    c.total > 0 ? (count / c.total) * 100 : 0;
  return {
    total: c.total,
    approved: c.approved,
    approvedPercent: pctOf(c.approved),
    rejected: c.rejected,
    rejectedPercent: pctOf(c.rejected),
    autoRejected: c.autoRejected,
    cancelled: c.cancelled,
    cancelledPercent: pctOf(c.cancelled),
    expired: c.expired,
    expiredPercent: pctOf(c.expired),
    pending: c.pending,
    pendingPercent: pctOf(c.pending),
  };
}

/** The late subset of a request's CANCELLED slots. `cancelledAt > startAt − lead` (D-11, P1 verbatim). */
export function lateCancelledSlots<
  S extends { startAt: Date; cancelledAt: Date | null },
>(cancelled: readonly S[], leadMs: number): S[] {
  return cancelled.filter(
    (slot) =>
      slot.cancelledAt !== null &&
      slot.cancelledAt.getTime() > slot.startAt.getTime() - leadMs,
  );
}

/** Folds discipline (late-cancellation count + granted-request denominator) over a request array. */
export function foldDiscipline<R extends { approvedAt: Date | null }>(
  rows: readonly R[],
  cancelledOf: (r: R) => readonly { startAt: Date; cancelledAt: Date | null }[],
  leadMs: number,
): { lateCancellations: number; grantedRequests: number } {
  let lateCancellations = 0;
  let grantedRequests = 0;
  for (const row of rows) {
    if (row.approvedAt === null) continue;
    grantedRequests += 1;
    if (lateCancelledSlots(cancelledOf(row), leadMs).length > 0) {
      lateCancellations += 1;
    }
  }
  return { lateCancellations, grantedRequests };
}

export function disciplineOf(
  f: { lateCancellations: number; grantedRequests: number },
  leadMinutes: number,
): DisciplineDto {
  return {
    lateCancellations: f.lateCancellations,
    noShows: null,
    grantedRequests: f.grantedRequests,
    lateCancellationPercent:
      f.grantedRequests > 0
        ? (f.lateCancellations / f.grantedRequests) * 100
        : 0,
    cancelLeadMinutes: leadMinutes,
  };
}

/**
 * Integer-millisecond accumulation (design §2.1.2, §2.1.4) — ORDER-INDEPENDENT and exact
 * (well under `2^53`). This is what makes AC-V4's cross-hub equality a bitwise identity.
 */
export function foldHeldMs<
  S extends { venueId: string; startAt: Date; endAt: Date },
>(
  slots: readonly S[],
  w: OpenReportWindow,
): { totalMs: number; msByVenue: Map<string, number> } {
  let totalMs = 0;
  const msByVenue = new Map<string, number>();
  for (const slot of slots) {
    const ms = splitAndClipMs(slot, w.startDate, w.effectiveEndDate);
    if (ms <= 0) continue;
    totalMs += ms;
    msByVenue.set(slot.venueId, (msByVenue.get(slot.venueId) ?? 0) + ms);
  }
  return { totalMs, msByVenue };
}

export function occupancyOf(
  heldHours: number,
  schoolDays: number,
  venueCount: number,
): OccupancyDto {
  const denominator = schoolDays * SCHOOL_DAY_HOURS * venueCount;
  return {
    heldHours,
    schoolDays,
    venueCount,
    occupancyPercent: denominator > 0 ? (heldHours / denominator) * 100 : null,
  };
}
