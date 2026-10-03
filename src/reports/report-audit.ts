import {
  AnnouncementAudience,
  BookingStatus,
  SystemRole,
} from '@prisma/client';
import { effectiveDepartmentIdOf } from '../bookings/booking-list-view';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import { matchesSearch } from '../common/search-text.util';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_ACTOR_HARD_DELETED,
  AUDIT_ACTOR_UNRECORDED,
  AUDIT_NO_DEPARTMENT,
  AUDIT_SOFT_DELETED_SUFFIX,
} from './audit-labels';
import { bangkokDate } from './report-calendar';
import { departmentBucketOf } from './report-operations';
import { docInt, thaiDateShort } from './report-thai';
import {
  AuditAction,
  AuditActorState,
  AuditSource,
  AuditTargetKind,
  type AuditActorDto,
  type AuditActorOptionDto,
  type AuditCapabilitiesDto,
  type AuditChangeDto,
  type AuditEventDto,
  type AuditKpisDto,
} from './dto/audit.dto';

/**
 * Hub 5's synthesis (design §1.2, PO ruling OQ-P3-1): there is no audit table, so every staff event is
 * reconstructed from the columns that already prove it. PURE: `ReportsActivityService` supplies the
 * rows; nothing here reads a clock or the database.
 *
 * The coverage table (design §1.2.1) is the contract: APPROVE, DIRECT_BOOKING, REJECT (actor unknown,
 * time approximate), CANCEL, ACCOUNT (creation only) and BROADCAST (actor unknown). `VENUE_UPDATE` is
 * never produced, no IP or user agent exists, and a field a source cannot supply is `null`, never
 * invented (D-13).
 */

export const AUDIT_CAPABILITIES: AuditCapabilitiesDto = {
  source: AuditSource.SYNTHESIZED,
  actions: [
    AuditAction.APPROVE,
    AuditAction.REJECT,
    AuditAction.CANCEL,
    AuditAction.DIRECT_BOOKING,
    AuditAction.ACCOUNT,
    AuditAction.BROADCAST,
  ],
  recordsIp: false,
  recordsResourceChanges: false,
};

// ── inputs (the selects of design §1.2.2, none of which carries requester PII) ───────────────────

export interface AuditVenueRef {
  name: string;
  deletedAt: Date | null;
}

export interface AuditRequestRow {
  id: string;
  code: string;
  status: BookingStatus;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  approvedById: string | null;
  createdById: string | null;
  firstStartAt: Date;
  venue: AuditVenueRef;
  departmentId: number | null;
  lineUser: { registration: { departmentId: number } | null } | null;
}

export interface AuditSlotRow {
  bookingRequestId: string;
  cancelledAt: Date | null;
  cancelledById: string | null;
  cancelledByRole: string | null;
  cancelReason: string | null;
  bookingRequest: {
    id: string;
    code: string;
    firstStartAt: Date;
    venue: AuditVenueRef;
    departmentId: number | null;
    lineUser: { registration: { departmentId: number } | null } | null;
    slots: ReadonlyArray<{ isCancelled: boolean; cancelledAt: Date | null }>;
  };
}

export interface AuditOptionRef {
  id?: number;
  name: string;
  isSystemReserved: boolean;
}

export interface AuditAccountRow {
  id: string;
  firstName: string;
  lastName: string;
  createdAt: Date;
  createdById: string | null;
  deletedAt: Date | null;
  department: AuditOptionRef;
  personnelRole: AuditOptionRef;
}

export interface AuditAnnouncementRow {
  id: string;
  title: string;
  sentAt: Date | null;
  sentCount: number;
  audience: AnnouncementAudience;
  deletedAt: Date | null;
  department: AuditOptionRef | null;
}

export interface AuditActorRow {
  id: string;
  firstName: string;
  lastName: string;
  role: SystemRole;
  deletedAt: Date | null;
  department: AuditOptionRef;
  personnelRole: AuditOptionRef;
}

export interface AuditSources {
  /** Inclusive start, exclusive end: the Bangkok day bounds of the range. */
  from: Date;
  to: Date;
  requests: readonly AuditRequestRow[];
  cancelSlots: readonly AuditSlotRow[];
  accounts: readonly AuditAccountRow[];
  announcements: readonly AuditAnnouncementRow[];
  departments: ReadonlyArray<{
    id: number;
    name: string;
    isSystemReserved: boolean;
  }>;
  actors: ReadonlyMap<string, AuditActorRow>;
  maySeeReserved: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

const inRange = (at: Date | null, from: Date, to: Date): at is Date =>
  at !== null && at.getTime() >= from.getTime() && at.getTime() < to.getTime();

const venueLabel = (v: AuditVenueRef): string =>
  `${v.name}${v.deletedAt ? AUDIT_SOFT_DELETED_SUFFIX : ''}`;

const fullName = (u: { firstName: string; lastName: string }): string =>
  `${u.firstName} ${u.lastName}`.trim();

function actorDtoOf(
  id: string | null,
  row: AuditActorRow | undefined,
  maySeeReserved: boolean,
  roleOverride?: SystemRole | null,
): AuditActorDto {
  if (!row) {
    // The row is gone (a hard delete): keep what the source still says, never invent a name.
    return {
      id,
      name: null,
      role: roleOverride ?? null,
      position: null,
      department: null,
      state: AuditActorState.HARD_DELETED,
    };
  }
  return {
    id: row.id,
    name: fullName(row),
    role: roleOverride ?? row.role,
    position:
      row.personnelRole.isSystemReserved && !maySeeReserved
        ? null
        : row.personnelRole.name,
    department:
      row.department.isSystemReserved && !maySeeReserved
        ? null
        : row.department.name,
    state: row.deletedAt
      ? AuditActorState.SOFT_DELETED
      : AuditActorState.ACTIVE,
  };
}

const asSystemRole = (role: string | null): SystemRole | null =>
  role === SystemRole.SUPER_ADMIN ||
  role === SystemRole.ADMIN ||
  role === SystemRole.VIEWER
    ? role
    : null;

const change = (
  field: string,
  before: string,
  after: string,
): AuditChangeDto => ({
  field,
  before,
  after,
});

// ── synthesis ────────────────────────────────────────────────────────────────────────────────────

export function synthesiseAuditEvents(src: AuditSources): AuditEventDto[] {
  const { from, to, maySeeReserved } = src;
  const deptById = new Map(src.departments.map((d) => [d.id, d]));
  const events: AuditEventDto[] = [];

  const deptNameOf = (row: {
    departmentId: number | null;
    lineUser: { registration: { departmentId: number } | null } | null;
  }): string => {
    const bucket = departmentBucketOf(
      effectiveDepartmentIdOf(row),
      deptById,
      maySeeReserved,
    );
    return bucket === null
      ? AUDIT_NO_DEPARTMENT
      : (deptById.get(bucket)?.name ?? AUDIT_NO_DEPARTMENT);
  };

  const requestTarget = (r: {
    id: string;
    code: string;
    venue: AuditVenueRef;
    departmentId: number | null;
    lineUser: { registration: { departmentId: number } | null } | null;
  }) => ({
    kind: AuditTargetKind.BOOKING_REQUEST,
    id: r.id,
    label: r.code,
    detail: `${venueLabel(r.venue)} · ${deptNameOf(r)}`,
    isDeleted: false,
  });

  for (const r of src.requests) {
    const date = thaiDateShort(bangkokDate(r.firstStartAt));
    const venue = venueLabel(r.venue);

    // APPROVE: a LIFF request (createdById null) a staff member ruled on.
    if (r.createdById === null && inRange(r.approvedAt, from, to)) {
      events.push({
        id: `APV-${r.code}`,
        at: r.approvedAt.toISOString(),
        atIsApproximate: false,
        action: AuditAction.APPROVE,
        actor: actorDtoOf(
          r.approvedById,
          r.approvedById ? src.actors.get(r.approvedById) : undefined,
          maySeeReserved,
        ),
        target: requestTarget(r),
        summary: `อนุมัติการใช้${venue} วันที่ ${date}`,
        changes: [change('สถานะคำขอ', 'รอพิจารณา', 'อนุมัติแล้ว')],
        note: null,
        ip: null,
        userAgent: null,
      });
    }

    // DIRECT_BOOKING: staff typed it in; creation IS the approval (D-C18).
    if (r.createdById !== null && inRange(r.createdAt, from, to)) {
      events.push({
        id: `DIR-${r.code}`,
        at: r.createdAt.toISOString(),
        atIsApproximate: false,
        action: AuditAction.DIRECT_BOOKING,
        actor: actorDtoOf(
          r.createdById,
          src.actors.get(r.createdById),
          maySeeReserved,
        ),
        target: requestTarget(r),
        summary: `จองแทน${deptNameOf(r)} ที่${venue} วันที่ ${date}`,
        changes: [change('สถานะคำขอ', '-', 'อนุมัติแล้ว')],
        note: null,
        ip: null,
        userAgent: null,
      });
    }

    // REJECT (manual): the reject writes no actor and no time, so `updatedAt` stands in.
    if (
      r.status === BookingStatus.REJECTED &&
      r.rejectReason !== AUTO_REJECTED_REASON &&
      inRange(r.updatedAt, from, to)
    ) {
      events.push({
        id: `REJ-${r.code}`,
        at: r.updatedAt.toISOString(),
        atIsApproximate: true,
        action: AuditAction.REJECT,
        actor: null,
        target: requestTarget(r),
        summary: `ปฏิเสธคำขอใช้${venue} วันที่ ${date}`,
        changes: [change('สถานะคำขอ', 'รอพิจารณา', 'ปฏิเสธ')],
        note: r.rejectReason,
        ip: null,
        userAgent: null,
      });
    }
  }

  // CANCEL: one event per (request, instant, canceller), carrying its slot count (E-11).
  const cancelGroups = new Map<string, AuditSlotRow[]>();
  for (const s of src.cancelSlots) {
    if (!inRange(s.cancelledAt, from, to)) continue;
    const key = `${s.bookingRequestId}|${s.cancelledAt.getTime()}|${s.cancelledById ?? ''}`;
    const list = cancelGroups.get(key);
    if (list) list.push(s);
    else cancelGroups.set(key, [s]);
  }
  for (const group of cancelGroups.values()) {
    const first = group[0];
    const at = first.cancelledAt as Date;
    const req = first.bookingRequest;
    const k = group.length;
    const allGone = req.slots.every(
      (s) => s.isCancelled && s.cancelledAt !== null && s.cancelledAt <= at,
    );
    events.push({
      id: `CAN-${req.code}-${at.getTime().toString(36)}`,
      at: at.toISOString(),
      atIsApproximate: false,
      action: AuditAction.CANCEL,
      actor:
        first.cancelledById === null
          ? null
          : actorDtoOf(
              first.cancelledById,
              src.actors.get(first.cancelledById),
              maySeeReserved,
              asSystemRole(first.cancelledByRole),
            ),
      target: requestTarget(req),
      summary: `ยกเลิกการจอง${venueLabel(req.venue)} วันที่ ${thaiDateShort(bangkokDate(req.firstStartAt))} จำนวน ${k} ช่วงเวลา`,
      changes: [
        change(
          'สถานะคำขอ',
          'อนุมัติแล้ว',
          allGone ? 'ยกเลิก' : 'อนุมัติแล้ว (ยกเลิกบางช่วงเวลา)',
        ),
        change('ช่วงเวลาที่ยกเลิก', '-', `${k} ช่วงเวลา`),
      ],
      note: first.cancelReason,
      ip: null,
      userAgent: null,
    });
  }

  // ACCOUNT: staff created by another staff member (the seeded first SUPER_ADMIN has no creator).
  for (const a of src.accounts) {
    if (a.createdById === null || !inRange(a.createdAt, from, to)) continue;
    const position =
      a.personnelRole.isSystemReserved && !maySeeReserved
        ? AUDIT_NO_DEPARTMENT
        : a.personnelRole.name;
    const dept =
      a.department.isSystemReserved && !maySeeReserved
        ? AUDIT_NO_DEPARTMENT
        : a.department.name;
    events.push({
      id: `ACC-${a.id}`,
      at: a.createdAt.toISOString(),
      atIsApproximate: false,
      action: AuditAction.ACCOUNT,
      actor: actorDtoOf(
        a.createdById,
        src.actors.get(a.createdById),
        maySeeReserved,
      ),
      target: {
        kind: AuditTargetKind.STAFF_ACCOUNT,
        id: a.id,
        label: fullName(a),
        detail: `${position} · ${dept}`,
        isDeleted: a.deletedAt !== null,
      },
      summary: 'สร้างบัญชีเจ้าหน้าที่ใหม่',
      changes: null,
      note: null,
      ip: null,
      userAgent: null,
    });
  }

  // BROADCAST: any SUPER_ADMIN/ADMIN may send any draft and `createdById` is the DRAFTER, so no actor.
  for (const n of src.announcements) {
    if (!inRange(n.sentAt, from, to)) continue;
    const recipients =
      n.audience === AnnouncementAudience.DEPARTMENT && n.department
        ? n.department.isSystemReserved && !maySeeReserved
          ? AUDIT_NO_DEPARTMENT
          : n.department.name
        : null;
    events.push({
      id: `ANN-${n.id}`,
      at: n.sentAt.toISOString(),
      atIsApproximate: false,
      action: AuditAction.BROADCAST,
      actor: null,
      target: {
        kind: AuditTargetKind.ANNOUNCEMENT,
        id: n.id,
        label: n.title,
        detail: recipients === null ? 'ผู้รับ ทุกคน' : `ผู้รับ ${recipients}`,
        isDeleted: n.deletedAt !== null,
      },
      summary: `ส่งประกาศถึงผู้ใช้ ${docInt(n.sentCount)} คน`,
      changes: [
        change('สถานะ', 'ฉบับร่าง', 'ส่งแล้ว'),
        change('จำนวนผู้รับ', '-', `${docInt(n.sentCount)} คน`),
      ],
      note: null,
      ip: null,
      userAgent: null,
    });
  }

  return events.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

// ── KPIs, actor options, filters, CSV ────────────────────────────────────────────────────────────

const isNamed = (a: AuditActorDto | null): a is AuditActorDto =>
  a !== null && a.name !== null && a.id !== null;

/** RANGE ONLY: computed over every event in the range, before any toolbar filter. */
export function auditKpisOf(
  events: readonly AuditEventDto[],
  days: number,
): AuditKpisDto {
  const count = (action: AuditAction) =>
    events.filter((e) => e.action === action).length;

  const byActor = new Map<string, { actor: AuditActorDto; count: number }>();
  for (const e of events) {
    if (!isNamed(e.actor)) continue;
    const cur = byActor.get(e.actor.id as string);
    if (cur) cur.count += 1;
    else byActor.set(e.actor.id as string, { actor: e.actor, count: 1 });
  }
  const top = [...byActor.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (a.actor.name as string).localeCompare(b.actor.name as string, 'th') ||
      (a.actor.id as string).localeCompare(b.actor.id as string),
  )[0];

  return {
    total: events.length,
    days,
    approve: count(AuditAction.APPROVE),
    reject: count(AuditAction.REJECT),
    cancel: count(AuditAction.CANCEL),
    directBooking: count(AuditAction.DIRECT_BOOKING),
    resourceChanges: null,
    topActor: top
      ? {
          actor: top.actor,
          count: top.count,
          percent: events.length > 0 ? (top.count / events.length) * 100 : 0,
        }
      : null,
  };
}

/** Staff with at least one NAMED event in the range, Thai-sorted. */
export function auditActorOptionsOf(
  events: readonly AuditEventDto[],
): AuditActorOptionDto[] {
  const byId = new Map<string, AuditActorOptionDto>();
  for (const e of events) {
    if (!isNamed(e.actor) || byId.has(e.actor.id as string)) continue;
    byId.set(e.actor.id as string, {
      id: e.actor.id as string,
      name: e.actor.name as string,
      isDeleted: e.actor.state === AuditActorState.SOFT_DELETED,
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'th') || a.id.localeCompare(b.id),
  );
}

export interface AuditFilter {
  action?: AuditAction;
  actorId?: string;
  q?: string;
}

export const isAuditFiltered = (f: AuditFilter): boolean =>
  f.action !== undefined ||
  f.actorId !== undefined ||
  (f.q !== undefined && f.q.trim() !== '');

export function filterAuditEvents(
  events: readonly AuditEventDto[],
  f: AuditFilter,
): AuditEventDto[] {
  return events.filter((e) => {
    if (f.action !== undefined && e.action !== f.action) return false;
    if (f.actorId !== undefined && e.actor?.id !== f.actorId) return false;
    if (f.q !== undefined && f.q.trim() !== '') {
      return matchesSearch(f.q, [
        e.id,
        e.target.label,
        e.target.detail,
        e.summary,
        e.note,
        e.actor?.name,
        e.actor?.department,
        AUDIT_ACTION_LABEL[e.action],
      ]);
    }
    return true;
  });
}

/** The actor cell of the CSV and the dialog (AC-A10). */
export function actorDisplayOf(actor: AuditActorDto | null): string {
  if (actor === null) return AUDIT_ACTOR_UNRECORDED;
  if (actor.state === AuditActorState.HARD_DELETED || actor.name === null) {
    return AUDIT_ACTOR_HARD_DELETED;
  }
  return actor.state === AuditActorState.SOFT_DELETED
    ? `${actor.name}${AUDIT_SOFT_DELETED_SUFFIX}`
    : actor.name;
}
