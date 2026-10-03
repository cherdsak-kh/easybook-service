import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { effectiveDepartmentIdOf } from '../bookings/booking-list-view';
import { readCancelLeadMinutes } from '../bookings/booking-settings';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../system-users/system-users.policy';
import { mayUseSystemReservedOptions } from '../system-users/system-users.policy';
import {
  bangkokDate,
  defaultTrendGrain,
  HOUR_MS,
  monthBuckets,
  schoolDaysByWeekday,
  splitAndClip,
  splitAndClipMs,
  type CalendarBucket,
} from './report-calendar';
import {
  attributedRequestWhere,
  clippedSchoolDays,
  codedError,
  compareDate,
  disciplineOf,
  effectiveDepartmentWhere,
  foldDiscipline,
  foldHeldMs,
  foldStatusCounts,
  heldSlotWhere,
  isOpen,
  occupancyOf,
  parseReportRange,
  rangeDtoOf,
  reportWindowAt,
  requestBreakdownOf,
  sumDailyCounts,
} from './report-fold';
import {
  buildVenueRows,
  foldHeatmap,
  toCellDtos,
  type HeatCell,
  type VenueRequestRowInput,
  type VenueRowInput,
} from './report-venues';
import {
  buildRegistry,
  departmentBucketOf,
  foldDepartments,
  foldPurposes,
  purposeCategoryOf,
  registryRowToDto,
  slaOf,
  type DepartmentRequestBucket,
  type DepartmentSourceRow,
} from './report-operations';
import {
  OccupancyDto,
  ReportRangeDto,
  ReportsOverviewResponseDto,
  TrendBucketDto,
  TrendDto,
  TrendGrain,
  VenueUsageDto,
} from './dto/reports-overview-response.dto';
import type { ReportsOperationsResponseDto } from './dto/reports-operations-response.dto';
import { ReportPurposeCategory } from './dto/reports-operations-response.dto';
import type { ReportsVenuesResponseDto } from './dto/reports-venues-response.dto';
import type { ReportsOverviewQueryDto } from './dto/reports-overview-query.dto';
import type { ReportsRangeQueryDto } from './dto/reports-range-query.dto';
import {
  HEAT_CELL_COUNT,
  REPORT_DEPARTMENT_INVALID_MESSAGE,
  REPORT_VENUE_INVALID_MESSAGE,
  SCHOOL_DAY_HOURS,
} from './reports.constants';
import { weekBuckets } from './report-calendar';

// ── Hub 1 (unchanged selects — the R1/R2 read is the same read Hub 2/3 make via heldSlotWhere) ────

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

// ── Hub 2 selects ───────────────────────────────────────────────────────────────────────────────

const V1_SELECT = {
  status: true,
  rejectReason: true,
  approvedAt: true,
  firstStartAt: true,
  venueId: true,
  slots: {
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    select: {
      startAt: true,
      endAt: true,
      isCancelled: true,
      cancelledAt: true,
    },
  },
} satisfies Prisma.BookingRequestSelect;
type V1Row = Prisma.BookingRequestGetPayload<{ select: typeof V1_SELECT }>;

// V2 uses R2_SELECT — byte-identical to Hub 1's unfiltered R2 (AC-V4 proof, §2.1.4).

// ── Hub 3 selects ───────────────────────────────────────────────────────────────────────────────

const O1_SELECT = {
  code: true,
  status: true,
  rejectReason: true,
  approvedAt: true,
  firstStartAt: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  venueId: true,
  purpose: true,
  departmentId: true,
  lineUser: { select: { registration: { select: { departmentId: true } } } },
  slots: {
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    select: {
      startAt: true,
      endAt: true,
      isCancelled: true,
      cancelledAt: true,
      cancelledByRole: true,
      cancelReason: true,
    },
  },
} satisfies Prisma.BookingRequestSelect;
type O1Row = Prisma.BookingRequestGetPayload<{ select: typeof O1_SELECT }>;

const O2_SELECT = {
  venueId: true,
  startAt: true,
  endAt: true,
  bookingRequest: {
    select: {
      purpose: true,
      departmentId: true,
      lineUser: {
        select: { registration: { select: { departmentId: true } } },
      },
    },
  },
} satisfies Prisma.BookingSlotSelect;
type O2Row = Prisma.BookingSlotGetPayload<{ select: typeof O2_SELECT }>;

/**
 * `ReportsController`'s three GETs — Hub 1's (P1), Hub 2's and Hub 3's aggregations (design §2.1,
 * §2.2, §2.3). Every figure is folded in TypeScript over bounded `findMany` reads (Prisma only, no
 * `$queryRaw`). All three share the populations built by `attributedRequestWhere`/`heldSlotWhere`
 * and the pure folds in `report-fold.ts`, `report-venues.ts` and `report-operations.ts` (design §2.1
 * — the shared-fold extraction). `getOverview`'s constructor and wire output are unchanged (P1
 * compat — `reports.service.spec.ts` and `test/reports-overview.e2e-spec.ts` stay green unedited).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(
    query: ReportsOverviewQueryDto,
    actor: Actor,
  ): Promise<ReportsOverviewResponseDto> {
    const parsedRange = parseReportRange(query.startDate, query.endDate);

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
    const w = reportWindowAt(parsedRange, serverTime);

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
    if (isOpen(w)) {
      [requestRows, slotRows] = await Promise.all([
        this.prisma.bookingRequest.findMany({
          where: attributedRequestWhere(w, {
            ...requestVenueWhere,
            ...deptWhere,
          }),
          select: R1_SELECT,
        }),
        this.prisma.bookingSlot.findMany({
          where: heldSlotWhere(w, venueWhere, deptWhere),
          select: R2_SELECT,
        }),
      ]);
    }

    const leadMs = cancelLeadMinutes * 60_000;

    const { counts: requestCounts, daily: dailyCounts } =
      foldStatusCounts(requestRows);
    const { lateCancellations, grantedRequests } = foldDiscipline(
      requestRows,
      (r) => r.slots,
      leadMs,
    );
    const requests = requestBreakdownOf(requestCounts);

    const { totalMs, msByVenue } = isOpen(w)
      ? foldHeldMs(slotRows, w)
      : { totalMs: 0, msByVenue: new Map<string, number>() };
    const heldHours = totalMs / HOUR_MS;

    const occupancy: OccupancyDto = occupancyOf(
      heldHours,
      w.schoolDays,
      venueCount,
    );

    const range: ReportRangeDto = rangeDtoOf(w, dataStartDate);

    // ── Trend buckets, both grains, folding the SAME two arrays (AC-R12 holds by construction) ──
    const buildBuckets = (buckets: CalendarBucket[]): TrendBucketDto[] =>
      buckets.map((bucket) => {
        const future = compareDate(bucket.from, w.dataUntilDate) > 0;
        const counts = sumDailyCounts(dailyCounts, bucket.from, bucket.to);
        const bucketSchoolDays = clippedSchoolDays(
          bucket.from,
          bucket.to,
          isOpen(w) ? w.effectiveEndDate : null,
        );
        const bucketHeldHours = isOpen(w)
          ? slotRows.reduce(
              (sum, slot) => sum + splitAndClip(slot, bucket.from, bucket.to),
              0,
            )
          : 0;
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
        defaultTrendGrain(parsedRange.days) === 'MONTH'
          ? TrendGrain.MONTH
          : TrendGrain.WEEK,
      month: buildBuckets(
        monthBuckets(parsedRange.startDate, parsedRange.endDate),
      ),
      week: buildBuckets(
        weekBuckets(parsedRange.startDate, parsedRange.endDate),
      ),
    };

    // ── Top venues: every venue with heldHours > 0, ranked desc then name ──
    let venues: VenueUsageDto[] = [];
    if (msByVenue.size > 0) {
      const venueRows = await this.prisma.venue.findMany({
        where: { id: { in: [...msByVenue.keys()] } },
        select: { id: true, name: true, isOpen: true, deletedAt: true },
      });
      const byId = new Map(venueRows.map((v) => [v.id, v]));
      venues = [...msByVenue.entries()]
        .map(([venueId, ms]) => {
          const v = byId.get(venueId);
          const hours = ms / HOUR_MS;
          return {
            venueId,
            name: v?.name ?? venueId,
            isDeleted: v ? v.deletedAt !== null : false,
            isOpen: v?.isOpen ?? false,
            heldHours: hours,
            sharePercent:
              w.schoolDays > 0
                ? (hours / (w.schoolDays * SCHOOL_DAY_HOURS)) * 100
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
      discipline: disciplineOf(
        { lateCancellations, grantedRequests },
        cancelLeadMinutes,
      ),
      pendingBacklog,
      trend,
      venues,
    };
  }

  /** Hub 2 — `GET /reports/venues` (design §2.5, §2.7). */
  async getVenues(
    query: ReportsRangeQueryDto,
  ): Promise<ReportsVenuesResponseDto> {
    const parsedRange = parseReportRange(query.startDate, query.endDate);
    const serverTime = new Date();
    const w = reportWindowAt(parsedRange, serverTime);

    const [dataStartAgg, venueCount, venueRowsRaw] = await Promise.all([
      this.prisma.bookingRequest.aggregate({ _min: { firstStartAt: true } }),
      this.prisma.venue.count({ where: { deletedAt: null, isOpen: true } }),
      this.prisma.venue.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          capacity: true,
          isOpen: true,
          deletedAt: true,
          venueType: { select: { name: true } },
        },
      }),
    ]);
    const dataStartDate = dataStartAgg._min.firstStartAt
      ? bangkokDate(dataStartAgg._min.firstStartAt)
      : null;

    let requestRows: V1Row[] = [];
    let slotRows: R2Row[] = [];
    if (isOpen(w)) {
      [requestRows, slotRows] = await Promise.all([
        this.prisma.bookingRequest.findMany({
          where: attributedRequestWhere(w),
          select: V1_SELECT,
        }),
        this.prisma.bookingSlot.findMany({
          where: heldSlotWhere(w),
          select: R2_SELECT,
        }),
      ]);
    }

    const { counts } = foldStatusCounts(requestRows);
    const requests = requestBreakdownOf(counts);

    const held = isOpen(w)
      ? foldHeldMs(slotRows, w)
      : { totalMs: 0, msByVenue: new Map<string, number>() };
    const heldHours = held.totalMs / HOUR_MS;
    const occupancy = occupancyOf(heldHours, w.schoolDays, venueCount);

    const clashPercent =
      requests.total > 0
        ? (requests.autoRejected / requests.total) * 100
        : null;

    const weekdaySchoolDays = isOpen(w)
      ? schoolDaysByWeekday(w.startDate, w.effectiveEndDate)
      : [0, 0, 0, 0, 0];

    const emptyHeatCells: HeatCell[] = Array.from(
      { length: HEAT_CELL_COUNT },
      () => ({ ms: 0, segments: 0 }),
    );
    const heat: { all: HeatCell[]; byVenue: Map<string, HeatCell[]> } = isOpen(
      w,
    )
      ? foldHeatmap(slotRows, w)
      : { all: emptyHeatCells, byVenue: new Map() };
    const heatmap = toCellDtos(heat.all);

    const venueRows: VenueRowInput[] = venueRowsRaw;
    const venueRequestRows: VenueRequestRowInput[] = requestRows;
    const venues = buildVenueRows(
      venueRows,
      venueRequestRows,
      held,
      heat,
      w.schoolDays,
    );

    return {
      serverTime,
      range: rangeDtoOf(w, dataStartDate),
      requests,
      occupancy,
      clashPercent,
      weekdaySchoolDays,
      heatmap,
      venues,
    };
  }

  /** Hub 3 — `GET /reports/operations` (design §2.6, §2.7). */
  async getOperations(
    query: ReportsRangeQueryDto,
    actor: Actor,
  ): Promise<ReportsOperationsResponseDto> {
    const parsedRange = parseReportRange(query.startDate, query.endDate);
    const serverTime = new Date();
    const w = reportWindowAt(parsedRange, serverTime);
    const maySeeReserved = mayUseSystemReservedOptions(actor);

    const [dataStartAgg, leadMinutes, departments] = await Promise.all([
      this.prisma.bookingRequest.aggregate({ _min: { firstStartAt: true } }),
      readCancelLeadMinutes(this.prisma),
      this.prisma.department.findMany({
        select: {
          id: true,
          name: true,
          deletedAt: true,
          isSystemReserved: true,
        },
      }),
    ]);
    const dataStartDate = dataStartAgg._min.firstStartAt
      ? bangkokDate(dataStartAgg._min.firstStartAt)
      : null;
    const leadMs = leadMinutes * 60_000;
    const deptById = new Map(departments.map((d) => [d.id, d]));

    let requestRows: O1Row[] = [];
    let slotRows: O2Row[] = [];
    if (isOpen(w)) {
      [requestRows, slotRows] = await Promise.all([
        this.prisma.bookingRequest.findMany({
          where: attributedRequestWhere(w),
          select: O1_SELECT,
        }),
        this.prisma.bookingSlot.findMany({
          where: heldSlotWhere(w),
          select: O2_SELECT,
        }),
      ]);
    }

    const { counts } = foldStatusCounts(requestRows);
    const requests = requestBreakdownOf(counts);
    const { lateCancellations, grantedRequests } = foldDiscipline(
      requestRows,
      (r) => r.slots.filter((s) => s.isCancelled),
      leadMs,
    );
    const discipline = disciplineOf(
      { lateCancellations, grantedRequests },
      leadMinutes,
    );

    const held = isOpen(w)
      ? foldHeldMs(slotRows, w)
      : { totalMs: 0, msByVenue: new Map<string, number>() };
    const heldHours = held.totalMs / HOUR_MS;

    const bucketOfRow = (row: {
      departmentId: number | null;
      lineUser: { registration: { departmentId: number } | null } | null;
    }): number | null =>
      departmentBucketOf(
        effectiveDepartmentIdOf(row),
        deptById,
        maySeeReserved,
      );

    const requestBuckets: DepartmentRequestBucket[] = requestRows.map(
      (row) => ({
        bucket: bucketOfRow(row),
        status: row.status,
        isLate:
          row.approvedAt !== null &&
          row.slots
            .filter((s) => s.isCancelled)
            .some(
              (s) =>
                s.cancelledAt !== null &&
                s.cancelledAt.getTime() > s.startAt.getTime() - leadMs,
            ),
      }),
    );

    const heldMsByBucket = new Map<number | null, number>();
    const heldMsByCategory = new Map<ReportPurposeCategory, number>();
    if (isOpen(w)) {
      for (const slot of slotRows) {
        const ms = splitAndClipMs(slot, w.startDate, w.effectiveEndDate);
        if (ms <= 0) continue;
        const bucket = bucketOfRow(slot.bookingRequest);
        heldMsByBucket.set(bucket, (heldMsByBucket.get(bucket) ?? 0) + ms);
        const category = purposeCategoryOf(slot.bookingRequest.purpose);
        heldMsByCategory.set(
          category,
          (heldMsByCategory.get(category) ?? 0) + ms,
        );
      }
    }

    const departmentSource: DepartmentSourceRow[] = departments;
    const departmentRows = foldDepartments(
      departmentSource,
      requestBuckets,
      heldMsByBucket,
      maySeeReserved,
    );

    const purposeRequests = requestRows.map((r) => ({
      category: purposeCategoryOf(r.purpose),
    }));
    const purposes = foldPurposes(purposeRequests, heldMsByCategory);

    const sla = slaOf(requestRows);

    const registryBuilt = buildRegistry(requestRows, leadMs, (row: O1Row) =>
      bucketOfRow(row),
    );

    let registry: ReportsOperationsResponseDto['registry'] = [];
    if (registryBuilt.length > 0) {
      const venueIds = [...new Set(registryBuilt.map((r) => r.venueId))];
      const venueRows = await this.prisma.venue.findMany({
        where: { id: { in: venueIds } },
        select: { id: true, name: true, deletedAt: true },
      });
      const venueById = new Map(venueRows.map((v) => [v.id, v]));
      registry = registryBuilt.map((row) => {
        const venue = venueById.get(row.venueId);
        const dept =
          row.departmentBucket !== null
            ? deptById.get(row.departmentBucket)
            : null;
        return registryRowToDto(
          row,
          {
            name: venue?.name ?? row.venueId,
            isDeleted: venue ? venue.deletedAt !== null : false,
          },
          {
            name: dept?.name ?? null,
            isDeleted: dept ? dept.deletedAt !== null : false,
          },
        );
      });
    }

    return {
      serverTime,
      range: rangeDtoOf(w, dataStartDate),
      requests,
      heldHours,
      discipline,
      departments: departmentRows,
      purposes,
      sla,
      registry,
    };
  }
}
