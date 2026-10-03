import { Injectable } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import { toCsv } from '../common/csv.util';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../system-users/system-users.policy';
import { mayUseSystemReservedOptions } from '../system-users/system-users.policy';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_NO_DEPARTMENT,
  AUDIT_ROLE_LABEL,
  AUDIT_TARGET_KIND_LABEL,
} from './audit-labels';
import {
  AUDIT_CAPABILITIES,
  actorDisplayOf,
  auditActorOptionsOf,
  auditKpisOf,
  filterAuditEvents,
  isAuditFiltered,
  synthesiseAuditEvents,
  type AuditActorRow,
  type AuditSources,
} from './report-audit';
import { addDays, bangkokDate, dayStart } from './report-calendar';
import { parseReportRange } from './report-fold';
import { docClock, thaiDateShort } from './report-thai';
import type {
  AuditActorsResponseDto,
  AuditEventDto,
  AuditKpisResponseDto,
  AuditPageDto,
  AuditRangeDto,
} from './dto/audit.dto';
import type {
  ReportsActivityFilterDto,
  ReportsActivityQueryDto,
} from './dto/reports-activity-query.dto';
import type { ReportsRangeQueryDto } from './dto/reports-range-query.dto';

const A1_SELECT = {
  id: true,
  code: true,
  status: true,
  rejectReason: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
  approvedById: true,
  createdById: true,
  firstStartAt: true,
  venue: { select: { name: true, deletedAt: true } },
  departmentId: true,
  lineUser: { select: { registration: { select: { departmentId: true } } } },
} satisfies Prisma.BookingRequestSelect;

const A2_SELECT = {
  bookingRequestId: true,
  cancelledAt: true,
  cancelledById: true,
  cancelledByRole: true,
  cancelReason: true,
  bookingRequest: {
    select: {
      id: true,
      code: true,
      firstStartAt: true,
      venue: { select: { name: true, deletedAt: true } },
      departmentId: true,
      lineUser: {
        select: { registration: { select: { departmentId: true } } },
      },
      slots: { select: { isCancelled: true, cancelledAt: true } },
    },
  },
} satisfies Prisma.BookingSlotSelect;

const OPTION_SELECT = { select: { name: true, isSystemReserved: true } };

const ACTOR_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  role: true,
  deletedAt: true,
  department: OPTION_SELECT,
  personnelRole: OPTION_SELECT,
} satisfies Prisma.SystemUserSelect;

interface Collected {
  serverTime: Date;
  range: AuditRangeDto;
  events: AuditEventDto[];
}

/**
 * Hub 5 (ประวัติการทำรายการ) read side. One private `collect` does every read and the synthesis; the
 * four public methods (page, KPIs, actor options, CSV) are views over its result, so they cannot
 * disagree. No audit table exists (PO ruling OQ-P3-1), so events are reconstructed from existing
 * columns: see `report-audit.ts` for the coverage table.
 *
 * Ranges INCLUDE today (D-16), so this does not use `reportWindowAt` (which stops at yesterday).
 * Events are filtered by THEIR OWN timestamp, never the booking's use date. Everything is read as
 * HISTORY: no `deletedAt` filter on an actor, a creator or a canceller.
 */
@Injectable()
export class ReportsActivityService {
  constructor(private readonly prisma: PrismaService) {}

  private async collect(
    startDate: string,
    endDate: string,
    actor: Actor,
  ): Promise<Collected> {
    const parsed = parseReportRange(startDate, endDate);
    const from = dayStart(parsed.startDate);
    const to = dayStart(addDays(parsed.endDate, 1));
    const serverTime = new Date();
    const maySeeReserved = mayUseSystemReservedOptions(actor);

    const [requests, cancelSlots, accounts, announcements, departments] =
      await Promise.all([
        this.prisma.bookingRequest.findMany({
          where: {
            OR: [
              // APPROVE
              { createdById: null, approvedAt: { gte: from, lt: to } },
              // DIRECT_BOOKING
              { createdById: { not: null }, createdAt: { gte: from, lt: to } },
              // REJECT (NULL-safe: `not` alone would drop a NULL reason)
              {
                status: BookingStatus.REJECTED,
                updatedAt: { gte: from, lt: to },
                OR: [
                  { rejectReason: null },
                  { rejectReason: { not: AUTO_REJECTED_REASON } },
                ],
              },
            ],
          },
          select: A1_SELECT,
        }),
        this.prisma.bookingSlot.findMany({
          where: {
            cancelledAt: { gte: from, lt: to },
            cancelledByRole: { in: ['SUPER_ADMIN', 'ADMIN'] },
          },
          select: A2_SELECT,
        }),
        this.prisma.systemUser.findMany({
          where: {
            createdById: { not: null },
            createdAt: { gte: from, lt: to },
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            createdAt: true,
            createdById: true,
            deletedAt: true,
            department: OPTION_SELECT,
            personnelRole: OPTION_SELECT,
          },
        }),
        this.prisma.announcement.findMany({
          where: { status: 'SENT', sentAt: { gte: from, lt: to } },
          select: {
            id: true,
            title: true,
            sentAt: true,
            sentCount: true,
            audience: true,
            deletedAt: true,
            department: OPTION_SELECT,
          },
        }),
        this.prisma.department.findMany({
          select: { id: true, name: true, isSystemReserved: true },
        }),
      ]);

    const actorIds = new Set<string>();
    for (const r of requests) {
      if (r.approvedById) actorIds.add(r.approvedById);
      if (r.createdById) actorIds.add(r.createdById);
    }
    for (const s of cancelSlots) {
      if (s.cancelledById) actorIds.add(s.cancelledById);
    }
    for (const a of accounts) {
      if (a.createdById) actorIds.add(a.createdById);
    }
    const actorRows: AuditActorRow[] =
      actorIds.size > 0
        ? await this.prisma.systemUser.findMany({
            where: { id: { in: [...actorIds] } },
            select: ACTOR_SELECT,
          })
        : [];

    const sources: AuditSources = {
      from,
      to,
      requests,
      cancelSlots,
      accounts,
      announcements,
      departments,
      actors: new Map(actorRows.map((a) => [a.id, a])),
      maySeeReserved,
    };
    return {
      serverTime,
      range: {
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        days: parsed.days,
      },
      events: synthesiseAuditEvents(sources),
    };
  }

  async list(
    query: ReportsActivityQueryDto,
    actor: Actor,
  ): Promise<AuditPageDto> {
    const { serverTime, range, events } = await this.collect(
      query.startDate,
      query.endDate,
      actor,
    );
    const filtered = filterAuditEvents(events, query);
    const limit = query.limit ?? 10;
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(1, query.page ?? 1), totalPages);
    return {
      serverTime,
      range,
      capabilities: AUDIT_CAPABILITIES,
      items: filtered.slice((page - 1) * limit, page * limit),
      page,
      limit,
      total,
      totalPages,
    };
  }

  async kpis(
    query: ReportsRangeQueryDto,
    actor: Actor,
  ): Promise<AuditKpisResponseDto> {
    const { serverTime, range, events } = await this.collect(
      query.startDate,
      query.endDate,
      actor,
    );
    return { serverTime, range, kpis: auditKpisOf(events, range.days) };
  }

  async actors(
    query: ReportsRangeQueryDto,
    actor: Actor,
  ): Promise<AuditActorsResponseDto> {
    const { serverTime, range, events } = await this.collect(
      query.startDate,
      query.endDate,
      actor,
    );
    return { serverTime, range, actors: auditActorOptionsOf(events) };
  }

  /** EVERY filtered row (not the current page), newest first. */
  async csv(
    query: ReportsActivityFilterDto,
    actor: Actor,
  ): Promise<{ fileName: string; body: string }> {
    const { range, events } = await this.collect(
      query.startDate,
      query.endDate,
      actor,
    );
    const rows = filterAuditEvents(events, query);
    const filtered = isAuditFiltered(query);
    const lines: Array<Array<string>> = [
      ['ประวัติการทำรายการ'],
      [
        `ช่วงข้อมูล ${thaiDateShort(range.startDate)} ถึง ${thaiDateShort(range.endDate)}${filtered ? ' (กรองแล้ว)' : ''}`,
      ],
      [],
      // `IP Address` and `อุปกรณ์` are omitted while the source records neither.
      [
        'รหัสเหตุการณ์',
        'วันที่',
        'เวลา',
        'เจ้าหน้าที่ผู้กระทำ',
        'บทบาท',
        'กลุ่ม/ฝ่าย',
        'การกระทำ',
        'ประเภทเป้าหมาย',
        'เป้าหมาย',
        'รายละเอียดเป้าหมาย',
        'สรุปการเปลี่ยนแปลง',
        'หมายเหตุ',
      ],
    ];
    for (const e of rows) {
      const at = new Date(e.at);
      lines.push([
        e.id,
        thaiDateShort(bangkokDate(at)),
        docClock(at),
        actorDisplayOf(e.actor),
        e.actor?.role ? AUDIT_ROLE_LABEL[e.actor.role] : '',
        e.actor ? (e.actor.department ?? AUDIT_NO_DEPARTMENT) : '',
        AUDIT_ACTION_LABEL[e.action],
        AUDIT_TARGET_KIND_LABEL[e.target.kind],
        e.target.label,
        e.target.detail ?? '',
        e.summary,
        e.note ?? '',
      ]);
    }
    return {
      fileName: `easybook-audit_${range.startDate}_${range.endDate}.csv`,
      body: toCsv(lines),
    };
  }
}
