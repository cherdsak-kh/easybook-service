import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { effectiveDepartmentIdOf } from '../bookings/booking-list-view';
import { readCancelLeadMinutes } from '../bookings/booking-settings';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../system-users/system-users.policy';
import { mayUseSystemReservedOptions } from '../system-users/system-users.policy';
import { bangkokDate, HOUR_MS, splitAndClipMs } from './report-calendar';
import { buildReportDocument, type LedgerSource } from './report-document';
import {
  attributedRequestWhere,
  disciplineOf,
  effectiveDepartmentWhere,
  foldDiscipline,
  foldHeldMs,
  foldStatusCounts,
  heldSlotWhere,
  isOpen,
  lateCancelledSlots,
  occupancyOf,
  parseReportRange,
  rangeDtoOf,
  reportWindowAt,
  requestBreakdownOf,
} from './report-fold';
import {
  departmentBucketOf,
  foldDepartments,
  slaOf,
  type DepartmentRequestBucket,
} from './report-operations';
import {
  exportCodedError,
  REPORT_DOCUMENT_MAX_ROWS,
  REPORT_DOCUMENT_TOO_LARGE_MESSAGE,
} from './report-export.constants';
import { periodLabelOf } from './report-thai';
import { buildVenueRows, foldHeatmap } from './report-venues';
import {
  REPORT_DEPARTMENT_INVALID_MESSAGE,
  REPORT_VENUE_INVALID_MESSAGE,
} from './reports.constants';
import type {
  ReportDocumentDto,
  ReportScopeOptionsDto,
} from './dto/report-document.dto';
import { ReportTemplate } from './dto/reports-export-query.dto';
import type { ReportsExportQueryDto } from './dto/reports-export-query.dto';

const X1_SELECT = {
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
    },
  },
} satisfies Prisma.BookingRequestSelect;
type X1Row = Prisma.BookingRequestGetPayload<{ select: typeof X1_SELECT }>;

const X2_SELECT = {
  venueId: true,
  startAt: true,
  endAt: true,
  bookingRequest: {
    select: {
      departmentId: true,
      lineUser: {
        select: { registration: { select: { departmentId: true } } },
      },
    },
  },
} satisfies Prisma.BookingSlotSelect;
type X2Row = Prisma.BookingSlotGetPayload<{ select: typeof X2_SELECT }>;

/**
 * Hub 4's one builder (design §2.3.2, D-5): every read happens once, here, on the SAME populations and
 * folds as Hubs 1 to 3 (`attributedRequestWhere`, `heldSlotWhere`, `foldHeldMs`, `buildVenueRows`,
 * `foldDepartments`, ...), so an unscoped แบบ 1 quotes exactly Hub 1's numbers for the same range.
 * `GET /reports/export` returns the model; `GET /reports/export/xlsx` serialises the same model.
 *
 * The requests select carries no requester name, phone, e-mail or LINE id (AC-E7): only
 * `lineUser.registration.departmentId`, and it never reaches a DTO.
 */
@Injectable()
export class ReportsExportService {
  constructor(private readonly prisma: PrismaService) {}

  async build(
    query: ReportsExportQueryDto,
    actor: Actor,
  ): Promise<ReportDocumentDto> {
    // 400 order, first failure wins: pipe -> date/inverted/too-wide -> period mismatch -> venue -> department.
    const parsedRange = parseReportRange(query.startDate, query.endDate);
    const periodLabel = periodLabelOf(
      query.period,
      parsedRange.startDate,
      parsedRange.endDate,
    );

    if (query.venueId) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: query.venueId },
        select: { id: true },
      });
      if (!venue) {
        throw exportCodedError(
          'REPORT_VENUE_INVALID',
          REPORT_VENUE_INVALID_MESSAGE,
        );
      }
    }
    const maySeeReserved = mayUseSystemReservedOptions(actor);
    if (query.departmentId !== undefined) {
      const department = await this.prisma.department.findUnique({
        where: { id: query.departmentId },
        select: { isSystemReserved: true },
      });
      if (!department || (department.isSystemReserved && !maySeeReserved)) {
        // Same body for "unknown" and "reserved, not allowed": never an existence oracle.
        throw exportCodedError(
          'REPORT_DEPARTMENT_INVALID',
          REPORT_DEPARTMENT_INVALID_MESSAGE,
        );
      }
    }

    const now = new Date();
    const w = reportWindowAt(parsedRange, now);

    const requestVenueWhere: Prisma.BookingRequestWhereInput = query.venueId
      ? { venueId: query.venueId }
      : {};
    const slotVenueWhere: Prisma.BookingSlotWhereInput = query.venueId
      ? { venueId: query.venueId }
      : {};
    const deptWhere =
      query.departmentId !== undefined
        ? effectiveDepartmentWhere(query.departmentId)
        : {};

    const [dataStartAgg, leadMinutes, venueCount, venues, departments] =
      await Promise.all([
        this.prisma.bookingRequest.aggregate({ _min: { firstStartAt: true } }),
        readCancelLeadMinutes(this.prisma),
        query.venueId
          ? Promise.resolve(1)
          : this.prisma.venue.count({
              where: { deletedAt: null, isOpen: true },
            }),
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

    let requestRows: X1Row[] = [];
    let slotRows: X2Row[] = [];
    if (isOpen(w)) {
      [requestRows, slotRows] = await Promise.all([
        this.prisma.bookingRequest.findMany({
          where: attributedRequestWhere(w, {
            ...requestVenueWhere,
            ...deptWhere,
          }),
          select: X1_SELECT,
        }),
        this.prisma.bookingSlot.findMany({
          where: heldSlotWhere(w, slotVenueWhere, deptWhere),
          select: X2_SELECT,
        }),
      ]);
    }
    if (
      query.template === ReportTemplate.LEDGER &&
      requestRows.length > REPORT_DOCUMENT_MAX_ROWS
    ) {
      throw exportCodedError(
        'REPORT_DOCUMENT_TOO_LARGE',
        REPORT_DOCUMENT_TOO_LARGE_MESSAGE,
      );
    }

    // ── folds: the existing functions, in the existing order ───────────────────────────────────
    const { counts } = foldStatusCounts(requestRows);
    const requests = requestBreakdownOf(counts);
    const discipline = disciplineOf(
      foldDiscipline(
        requestRows,
        (r) => r.slots.filter((s) => s.isCancelled),
        leadMs,
      ),
      leadMinutes,
    );
    const held = isOpen(w)
      ? foldHeldMs(slotRows, w)
      : { totalMs: 0, msByVenue: new Map<string, number>() };
    const heldHours = held.totalMs / HOUR_MS;
    const occupancy = occupancyOf(heldHours, w.schoolDays, venueCount);
    const sla = slaOf(requestRows);

    const deptById = new Map(departments.map((d) => [d.id, d]));
    const bucketOfRow = (r: {
      departmentId: number | null;
      lineUser: { registration: { departmentId: number } | null } | null;
    }): number | null =>
      departmentBucketOf(effectiveDepartmentIdOf(r), deptById, maySeeReserved);

    const heat = isOpen(w) ? foldHeatmap(slotRows, w) : null;
    const venueRowsAll = buildVenueRows(
      venues,
      requestRows,
      held,
      heat ?? { byVenue: new Map() },
      w.schoolDays,
    );
    const venueRows = query.venueId
      ? venueRowsAll.filter((v) => v.venueId === query.venueId)
      : venueRowsAll;

    const requestBuckets: DepartmentRequestBucket[] = requestRows.map((r) => ({
      bucket: bucketOfRow(r),
      status: r.status,
      isLate:
        r.approvedAt !== null &&
        lateCancelledSlots(
          r.slots.filter((s) => s.isCancelled),
          leadMs,
        ).length > 0,
    }));
    const heldMsByBucket = new Map<number | null, number>();
    const heldMsByVenueBucket = new Map<string, Map<number, number>>();
    if (isOpen(w)) {
      for (const slot of slotRows) {
        const ms = splitAndClipMs(slot, w.startDate, w.effectiveEndDate);
        if (ms <= 0) continue;
        const bucket = bucketOfRow(slot.bookingRequest);
        heldMsByBucket.set(bucket, (heldMsByBucket.get(bucket) ?? 0) + ms);
        if (bucket !== null) {
          const perVenue =
            heldMsByVenueBucket.get(slot.venueId) ?? new Map<number, number>();
          perVenue.set(bucket, (perVenue.get(bucket) ?? 0) + ms);
          heldMsByVenueBucket.set(slot.venueId, perVenue);
        }
      }
    }
    const departmentRowsAll = foldDepartments(
      departments,
      requestBuckets,
      heldMsByBucket,
      maySeeReserved,
    );
    const departmentRows =
      query.departmentId !== undefined
        ? departmentRowsAll.filter((d) => d.departmentId === query.departmentId)
        : departmentRowsAll;

    // The main user of a venue: the non-null bucket with the most held ms (ties: Thai name order).
    const mainUserByVenue = new Map<
      string,
      { name: string; fraction: number }
    >();
    for (const [venueId, perBucket] of heldMsByVenueBucket) {
      const venueMs = held.msByVenue.get(venueId) ?? 0;
      if (venueMs <= 0) continue;
      const best = [...perBucket.entries()]
        .map(([id, ms]) => ({ name: deptById.get(id)?.name ?? '', ms }))
        .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name, 'th'))[0];
      if (best) {
        mainUserByVenue.set(venueId, {
          name: best.name,
          fraction: best.ms / venueMs,
        });
      }
    }

    const ledger: LedgerSource[] = requestRows;
    const body = buildReportDocument({
      template: query.template,
      period: query.period,
      startDate: parsedRange.startDate,
      endDate: parsedRange.endDate,
      now,
      periodLabel,
      venueScopeName: query.venueId
        ? (venues.find((v) => v.id === query.venueId)?.name ?? null)
        : null,
      departmentScopeName:
        query.departmentId !== undefined
          ? (deptById.get(query.departmentId)?.name ?? null)
          : null,
      requests,
      occupancy,
      discipline,
      sla,
      venueRows,
      departmentRows,
      mainUserByVenue,
      ledger,
      venueById: new Map(venues.map((v) => [v.id, v])),
      departmentById: deptById,
      maySeeReserved,
      leadMs,
      isEmpty: requests.total === 0 && held.totalMs === 0,
    });

    return {
      serverTime: now,
      range: rangeDtoOf(w, dataStartDate),
      template: query.template,
      period: query.period,
      ...body,
    };
  }

  /** Every venue (deleted included) and every department (the reserved one only for SUPER_ADMIN). */
  async scopeOptions(actor: Actor): Promise<ReportScopeOptionsDto> {
    const maySeeReserved = mayUseSystemReservedOptions(actor);
    const [venues, departments] = await Promise.all([
      this.prisma.venue.findMany({
        select: { id: true, name: true, isOpen: true, deletedAt: true },
      }),
      this.prisma.department.findMany({
        where: maySeeReserved ? {} : { isSystemReserved: false },
        select: { id: true, name: true, deletedAt: true },
      }),
    ]);
    return {
      venues: venues
        .map((v) => ({
          id: v.id,
          name: v.name,
          isDeleted: v.deletedAt !== null,
          isOpen: v.isOpen,
        }))
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, 'th') || a.id.localeCompare(b.id),
        ),
      departments: departments
        .map((d) => ({
          id: d.id,
          name: d.name,
          isDeleted: d.deletedAt !== null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'th') || a.id - b.id),
    };
  }
}
