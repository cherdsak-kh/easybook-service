import { BadRequestException, Injectable } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { readCancelLeadMinutes } from '../bookings/booking-settings';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../system-users/system-users.policy';
import { mayUseSystemReservedOptions } from '../system-users/system-users.policy';
import {
  addDays,
  bangkokDate,
  dayStart,
  defaultTrendGrain,
  inclusiveDays,
  monthBuckets,
  parseReportDate,
  schoolDaysIn,
  splitAndClip,
  type CalendarBucket,
} from './report-calendar';
import {
  OccupancyDto,
  ReportRangeDto,
  ReportsOverviewResponseDto,
  RequestBreakdownDto,
  TrendBucketDto,
  TrendDto,
  TrendGrain,
  VenueUsageDto,
} from './dto/reports-overview-response.dto';
import type { ReportsOverviewQueryDto } from './dto/reports-overview-query.dto';
import {
  REPORT_DATE_INVALID_MESSAGE,
  REPORT_DEPARTMENT_INVALID_MESSAGE,
  REPORT_MAX_DAYS,
  REPORT_RANGE_INVERTED_MESSAGE,
  REPORT_RANGE_TOO_WIDE_MESSAGE,
  REPORT_VENUE_INVALID_MESSAGE,
  SCHOOL_DAY_HOURS,
  type ReportErrorCode,
} from './reports.constants';
import { weekBuckets } from './report-calendar';

/** Wraps `IntegrationsService`'s `codedError()` shape (same convention, own file). */
function codedError(
  code: ReportErrorCode,
  message: string,
): BadRequestException {
  const base = new BadRequestException(message).getResponse() as Record<
    string,
    unknown
  >;
  return new BadRequestException({ ...base, code });
}

function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
const minDate = (a: string, b: string): string =>
  compareDate(a, b) <= 0 ? a : b;

interface DayCounts {
  total: number;
  approved: number;
  rejected: number;
  autoRejected: number;
  cancelled: number;
  expired: number;
  pending: number;
}

function emptyDayCounts(): DayCounts {
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

/** design §1.3's `effectiveDepartmentWhere` — mirrors `requesterOf()`'s "registration wins" rule exactly. */
function effectiveDepartmentWhere(
  departmentId: number,
): Prisma.BookingRequestWhereInput {
  return {
    OR: [
      { lineUser: { is: { registration: { is: { departmentId } } } } },
      {
        departmentId,
        OR: [
          { lineUserId: null },
          { lineUser: { is: { registration: { is: null } } } },
        ],
      },
    ],
  };
}

const R1_SELECT = {
  status: true,
  rejectReason: true,
  approvedAt: true,
  firstStartAt: true,
  slots: {
    where: { isCancelled: true },
    select: { startAt: true, cancelledAt: true },
  },
} satisfies Prisma.BookingRequestSelect;
type R1Row = Prisma.BookingRequestGetPayload<{ select: typeof R1_SELECT }>;

const R2_SELECT = {
  venueId: true,
  startAt: true,
  endAt: true,
} satisfies Prisma.BookingSlotSelect;
type R2Row = Prisma.BookingSlotGetPayload<{ select: typeof R2_SELECT }>;

/**
 * `ReportsController`'s single GET — Hub 1's aggregation (design §1.2, §1.3, §2.5). Every figure is
 * folded in TypeScript over two bounded `findMany` reads (Prisma only, no `$queryRaw` — §1.2). Reuses
 * `readCancelLeadMinutes` (extracted, not duplicated) and the imported `AUTO_REJECTED_REASON`
 * constant (never a second copy — R-2).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(
    query: ReportsOverviewQueryDto,
    actor: Actor,
  ): Promise<ReportsOverviewResponseDto> {
    const startDate = parseReportDate(query.startDate);
    const endDate = parseReportDate(query.endDate);
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

    if (query.venueId) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: query.venueId },
        select: { id: true },
      });
      if (!venue) {
        throw codedError('REPORT_VENUE_INVALID', REPORT_VENUE_INVALID_MESSAGE);
      }
    }
    if (query.departmentId !== undefined) {
      const department = await this.prisma.department.findUnique({
        where: { id: query.departmentId },
        select: { isSystemReserved: true },
      });
      if (
        !department ||
        (department.isSystemReserved && !mayUseSystemReservedOptions(actor))
      ) {
        // Same body for "unknown" and "reserved, not allowed" — never an existence oracle.
        throw codedError(
          'REPORT_DEPARTMENT_INVALID',
          REPORT_DEPARTMENT_INVALID_MESSAGE,
        );
      }
    }

    const serverTime = new Date();
    const today = bangkokDate(serverTime);
    const dataUntilDate = addDays(today, -1);
    const effectiveEndDate = minDate(endDate, dataUntilDate);
    const isEmpty = compareDate(startDate, effectiveEndDate) > 0;

    const venueWhere: Prisma.BookingSlotWhereInput = query.venueId
      ? { venueId: query.venueId }
      : {};
    const requestVenueWhere: Prisma.BookingRequestWhereInput = query.venueId
      ? { venueId: query.venueId }
      : {};
    const deptWhere =
      query.departmentId !== undefined
        ? effectiveDepartmentWhere(query.departmentId)
        : {};

    const [pendingBacklog, dataStartAgg, cancelLeadMinutes, venueCount] =
      await Promise.all([
        this.prisma.bookingRequest.count({
          where: { status: BookingStatus.PENDING },
        }),
        this.prisma.bookingRequest.aggregate({ _min: { firstStartAt: true } }),
        readCancelLeadMinutes(this.prisma),
        query.venueId
          ? Promise.resolve(1)
          : this.prisma.venue.count({
              where: { deletedAt: null, isOpen: true },
            }),
      ]);
    const dataStartDate = dataStartAgg._min.firstStartAt
      ? bangkokDate(dataStartAgg._min.firstStartAt)
      : null;

    let requestRows: R1Row[] = [];
    let slotRows: R2Row[] = [];
    if (!isEmpty) {
      const S = dayStart(startDate);
      const E = dayStart(addDays(effectiveEndDate, 1));
      [requestRows, slotRows] = await Promise.all([
        this.prisma.bookingRequest.findMany({
          where: {
            firstStartAt: { gte: S, lt: E },
            ...requestVenueWhere,
            ...deptWhere,
          },
          select: R1_SELECT,
        }),
        this.prisma.bookingSlot.findMany({
          where: {
            isCancelled: false,
            startAt: { lt: E },
            endAt: { gt: S },
            ...venueWhere,
            bookingRequest: { status: BookingStatus.APPROVED, ...deptWhere },
          },
          select: R2_SELECT,
        }),
      ]);
    }

    const leadMs = cancelLeadMinutes * 60_000;

    // ── Fold R1: totals, per-day counts (for buckets), late cancellations ──
    const requestCounts: DayCounts = emptyDayCounts();
    const dailyCounts = new Map<string, DayCounts>();
    let lateCancellations = 0;
    let grantedRequests = 0;

    for (const row of requestRows) {
      requestCounts.total += 1;
      const date = bangkokDate(row.firstStartAt);
      const day = dailyCounts.get(date) ?? emptyDayCounts();
      day.total += 1;

      switch (row.status) {
        case BookingStatus.APPROVED:
          requestCounts.approved += 1;
          day.approved += 1;
          break;
        case BookingStatus.REJECTED: {
          requestCounts.rejected += 1;
          day.rejected += 1;
          if (row.rejectReason === AUTO_REJECTED_REASON) {
            requestCounts.autoRejected += 1;
            day.autoRejected += 1;
          }
          break;
        }
        case BookingStatus.CANCELLED:
          requestCounts.cancelled += 1;
          day.cancelled += 1;
          break;
        case BookingStatus.EXPIRED:
          requestCounts.expired += 1;
          day.expired += 1;
          break;
        case BookingStatus.PENDING:
          requestCounts.pending += 1;
          day.pending += 1;
          break;
      }
      dailyCounts.set(date, day);

      if (row.approvedAt !== null) {
        grantedRequests += 1;
        const isLate = row.slots.some(
          (slot) =>
            slot.cancelledAt !== null &&
            slot.cancelledAt.getTime() > slot.startAt.getTime() - leadMs,
        );
        if (isLate) lateCancellations += 1;
      }
    }
    const lateCancellationPercent =
      grantedRequests > 0 ? (lateCancellations / grantedRequests) * 100 : 0;

    // OQ-2 (PO ruling): every status gets a `*Percent` alongside its count, unrounded, so
    // approvedPercent + rejectedPercent + cancelledPercent + expiredPercent + pendingPercent sums to
    // exactly 100 whenever total > 0 — true BY CONSTRUCTION, because the five counts already sum to
    // `total` (every row falls into exactly one of the five `BookingStatus` values).
    const pctOf = (count: number): number =>
      requestCounts.total > 0 ? (count / requestCounts.total) * 100 : 0;
    const requests: RequestBreakdownDto = {
      total: requestCounts.total,
      approved: requestCounts.approved,
      approvedPercent: pctOf(requestCounts.approved),
      rejected: requestCounts.rejected,
      rejectedPercent: pctOf(requestCounts.rejected),
      autoRejected: requestCounts.autoRejected,
      cancelled: requestCounts.cancelled,
      cancelledPercent: pctOf(requestCounts.cancelled),
      expired: requestCounts.expired,
      expiredPercent: pctOf(requestCounts.expired),
      pending: requestCounts.pending,
      pendingPercent: pctOf(requestCounts.pending),
    };

    // ── Fold R2: held hours, total + per venue ──
    let heldHours = 0;
    const heldHoursByVenue = new Map<string, number>();
    if (!isEmpty) {
      for (const slot of slotRows) {
        const contribution = splitAndClip(slot, startDate, effectiveEndDate);
        if (contribution <= 0) continue;
        heldHours += contribution;
        heldHoursByVenue.set(
          slot.venueId,
          (heldHoursByVenue.get(slot.venueId) ?? 0) + contribution,
        );
      }
    }

    const schoolDaysInRange = isEmpty
      ? 0
      : schoolDaysIn(startDate, effectiveEndDate);
    const occupancyDenominator =
      schoolDaysInRange * SCHOOL_DAY_HOURS * venueCount;
    const occupancy: OccupancyDto = {
      heldHours,
      schoolDays: schoolDaysInRange,
      venueCount,
      occupancyPercent:
        occupancyDenominator > 0
          ? (heldHours / occupancyDenominator) * 100
          : null,
    };

    const range: ReportRangeDto = {
      startDate,
      endDate,
      dataUntilDate,
      effectiveEndDate: isEmpty ? null : effectiveEndDate,
      days,
      schoolDays: schoolDaysInRange,
      dataStartDate,
    };

    // ── Trend buckets, both grains, folding the SAME two arrays (AC-R12 holds by construction) ──
    const buildBuckets = (buckets: CalendarBucket[]): TrendBucketDto[] =>
      buckets.map((bucket) => {
        const future = compareDate(bucket.from, dataUntilDate) > 0;
        const counts = sumDailyCounts(dailyCounts, bucket.from, bucket.to);
        const bucketSchoolDays = clippedSchoolDays(
          bucket.from,
          bucket.to,
          isEmpty ? null : effectiveEndDate,
        );
        const bucketHeldHours = isEmpty
          ? 0
          : slotRows.reduce(
              (sum, slot) => sum + splitAndClip(slot, bucket.from, bucket.to),
              0,
            );
        const bucketDenominator =
          bucketSchoolDays * SCHOOL_DAY_HOURS * venueCount;
        return {
          from: bucket.from,
          to: bucket.to,
          partial: bucket.partial,
          future,
          total: counts.total,
          approved: counts.approved,
          rejected: counts.rejected,
          autoRejected: counts.autoRejected,
          cancelled: counts.cancelled,
          expired: counts.expired,
          pending: counts.pending,
          heldHours: bucketHeldHours,
          schoolDays: bucketSchoolDays,
          occupancyPercent:
            !future && bucketDenominator > 0
              ? (bucketHeldHours / bucketDenominator) * 100
              : null,
        };
      });

    const trend: TrendDto = {
      defaultGrain:
        defaultTrendGrain(days) === 'MONTH'
          ? TrendGrain.MONTH
          : TrendGrain.WEEK,
      month: buildBuckets(monthBuckets(startDate, endDate)),
      week: buildBuckets(weekBuckets(startDate, endDate)),
    };

    // ── Top venues: every venue with heldHours > 0, ranked desc then name ──
    let venues: VenueUsageDto[] = [];
    if (heldHoursByVenue.size > 0) {
      const venueRows = await this.prisma.venue.findMany({
        where: { id: { in: [...heldHoursByVenue.keys()] } },
        select: { id: true, name: true, isOpen: true, deletedAt: true },
      });
      const byId = new Map(venueRows.map((v) => [v.id, v]));
      venues = [...heldHoursByVenue.entries()]
        .map(([venueId, hours]) => {
          const v = byId.get(venueId);
          return {
            venueId,
            name: v?.name ?? venueId,
            isDeleted: v ? v.deletedAt !== null : false,
            isOpen: v?.isOpen ?? false,
            heldHours: hours,
            sharePercent:
              schoolDaysInRange > 0
                ? (hours / (schoolDaysInRange * SCHOOL_DAY_HOURS)) * 100
                : 0,
          };
        })
        .sort(
          (a, b) => b.heldHours - a.heldHours || a.name.localeCompare(b.name),
        )
        .map((v, i) => ({ rank: i + 1, ...v }));
    }

    return {
      serverTime,
      range,
      requests,
      occupancy,
      discipline: {
        lateCancellations,
        noShows: null,
        grantedRequests,
        lateCancellationPercent,
        cancelLeadMinutes,
      },
      pendingBacklog,
      trend,
      venues,
    };
  }
}

function sumDailyCounts(
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
function clippedSchoolDays(
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
