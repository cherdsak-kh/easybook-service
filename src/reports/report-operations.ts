import { BookingStatus } from '@prisma/client';
import { sanitizeThaiText } from '../common/sanitize-thai.util';
import { bangkokDate, HOUR_MS } from './report-calendar';
import { isAutoRejected, lateCancelledSlots } from './report-fold';
import { SLA_BUCKET_BOUNDS_HOURS, SLA_HOURS } from './reports.constants';
import {
  ReportCancellerKind,
  ReportPurposeCategory,
  ReportSlaBucket,
  type ReportDepartmentRowDto,
  type ReportLateCancellationDto,
  type ReportPurposeRowDto,
  type ReportSlaBucketRowDto,
  type ReportSlaDto,
} from './dto/reports-operations-response.dto';

/**
 * Hub 3's pure formulas (design §2.3) — the purpose classifier, SLA calculator, late-cancellation
 * registry builder, and department folding (incl. the D-20 reserved-department fold). Nothing here
 * does I/O; `reports.service.ts` supplies already-read Prisma rows.
 */

// ── §2.3.3 purpose classifier ────────────────────────────────────────────────────────────────────

/**
 * Phrases that contain a keyword but are never a category signal (venue names, formal phrasing).
 * Scrubbed (replaced with a space) BEFORE keyword matching.
 */
const SCRUB_PHRASES = [
  'โรงเรียน',
  'ห้องประชุม',
  'หอประชุม',
  'สนามกีฬา',
  'ตรวจสอบ',
  'สอบถาม',
  'เรียนเชิญ',
];

interface PurposeRule {
  category: ReportPurposeCategory;
  keywords: readonly string[];
}

/** First-match-wins, in this order (design §2.3.3, AC-O9). */
export const PURPOSE_RULES: readonly PurposeRule[] = [
  {
    category: ReportPurposeCategory.TRAINING,
    keywords: [
      'อบรม',
      'สัมมนา',
      'พัฒนาบุคลากร',
      'พัฒนาครู',
      'วิทยากร',
      'ประชุมเชิงปฏิบัติการ',
      'ศึกษาดูงาน',
      'plc',
      'workshop',
      'seminar',
      'training',
    ],
  },
  {
    category: ReportPurposeCategory.MEETING,
    keywords: ['ประชุม', 'บริหาร', 'meeting'],
  },
  {
    category: ReportPurposeCategory.STUDENT_ACTIVITY,
    keywords: [
      'ชมรม',
      'กีฬา',
      'ซ้อม',
      'แข่ง',
      'ค่าย',
      'ลูกเสือ',
      'เนตรนารี',
      'ยุวกาชาด',
      'การแสดง',
      'ดนตรี',
      'นาฏศิลป์',
      'เชียร์',
      'บอล',
      'กิจกรรมนักเรียน',
      'สภานักเรียน',
      'club',
      'sport',
    ],
  },
  {
    category: ReportPurposeCategory.TEACHING,
    keywords: [
      'สอน',
      'เรียน',
      'คาบ',
      'ติว',
      'สอบ',
      'วิชา',
      'class',
      'exam',
      'lesson',
      'tutor',
    ],
  },
];

/** The tie-break order for the 4 real categories in `foldPurposes` (§2.3.3's rule list, not the enum's declaration order). */
const CATEGORY_RANK: Record<ReportPurposeCategory, number> = {
  [ReportPurposeCategory.TRAINING]: 1,
  [ReportPurposeCategory.MEETING]: 2,
  [ReportPurposeCategory.STUDENT_ACTIVITY]: 3,
  [ReportPurposeCategory.TEACHING]: 4,
  [ReportPurposeCategory.OTHER]: 5,
};

/** Zero-width joiners/space (U+200B–U+200D) and a stray BOM (U+FEFF), built via `fromCharCode` so
 *  the literal code points never sit in source as an ordinary character class (design §2.3.3). */
const ZERO_WIDTH_AND_BOM = new RegExp(
  '[' +
    String.fromCharCode(0x200b) +
    '-' +
    String.fromCharCode(0x200d) +
    String.fromCharCode(0xfeff) +
    ']',
  'g',
);

function normalise(text: string): string {
  const sanitised = sanitizeThaiText({ value: text });
  const base = typeof sanitised === 'string' ? sanitised : text;
  return base
    .normalize('NFC')
    .replace(ZERO_WIDTH_AND_BOM, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function scrub(text: string): string {
  let s = text;
  for (const phrase of SCRUB_PHRASES) s = s.split(phrase).join(' ');
  return s;
}

/** D-22: maps free-text `purpose` to one of the four categories, else `OTHER` (AC-O9). */
export function purposeCategoryOf(
  text: string | null | undefined,
): ReportPurposeCategory {
  const scrubbed = scrub(normalise(text ?? ''));
  for (const rule of PURPOSE_RULES) {
    if (rule.keywords.some((k) => scrubbed.includes(k))) return rule.category;
  }
  return ReportPurposeCategory.OTHER;
}

/**
 * Folds `requests` (counted by category) and `heldMsByCategory` (already-clipped ms, keyed by
 * category) into the fixed 5-row purpose table. Real categories sorted by hours desc, requests
 * desc, then the §2.3.3 rule order; `OTHER` always last (D-22).
 */
export function foldPurposes(
  requests: readonly { category: ReportPurposeCategory }[],
  heldMsByCategory: ReadonlyMap<ReportPurposeCategory, number>,
): ReportPurposeRowDto[] {
  const ALL_CATEGORIES: ReportPurposeCategory[] = [
    ReportPurposeCategory.TEACHING,
    ReportPurposeCategory.MEETING,
    ReportPurposeCategory.TRAINING,
    ReportPurposeCategory.STUDENT_ACTIVITY,
    ReportPurposeCategory.OTHER,
  ];
  const counts = new Map<ReportPurposeCategory, number>();
  for (const r of requests)
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const totalHeldMs = [...heldMsByCategory.values()].reduce((s, x) => s + x, 0);

  const rows = ALL_CATEGORIES.map((category) => {
    const heldMs = heldMsByCategory.get(category) ?? 0;
    return {
      category,
      requests: counts.get(category) ?? 0,
      heldHours: heldMs / HOUR_MS,
      sharePercent: totalHeldMs > 0 ? (heldMs / totalHeldMs) * 100 : 0,
    };
  });

  rows.sort((a, b) => {
    if (a.category === ReportPurposeCategory.OTHER) return 1;
    if (b.category === ReportPurposeCategory.OTHER) return -1;
    return (
      b.heldHours - a.heldHours ||
      b.requests - a.requests ||
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]
    );
  });
  return rows;
}

// ── §2.3.4 SLA ────────────────────────────────────────────────────────────────────────────────────

export interface SlaSourceRow {
  createdById: string | null;
  approvedAt: Date | null;
  status: BookingStatus;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * D-23/D-24: partitions attributed requests exhaustively (staff-created → decided-approved →
 * auto-rejected → decided-rejected → withdrawn → expired → pending), computes wall-clock turnaround
 * in integer ms, and buckets it. `n + Σ excluded.* = requests.total` (AC-O10/O11).
 */
export function slaOf(rows: readonly SlaSourceRow[]): ReportSlaDto {
  let decidedApproved = 0;
  let decidedRejected = 0;
  let autoRejected = 0;
  let withdrawn = 0;
  let staffCreated = 0;
  let expired = 0;
  let pending = 0;
  const turnaroundsMs: number[] = [];

  for (const row of rows) {
    if (row.createdById !== null) {
      staffCreated += 1;
      continue;
    }
    if (row.approvedAt !== null) {
      decidedApproved += 1;
      turnaroundsMs.push(
        Math.max(0, row.approvedAt.getTime() - row.createdAt.getTime()),
      );
      continue;
    }
    if (row.status === BookingStatus.REJECTED && isAutoRejected(row)) {
      autoRejected += 1;
      continue;
    }
    if (row.status === BookingStatus.REJECTED) {
      decidedRejected += 1;
      turnaroundsMs.push(
        Math.max(0, row.updatedAt.getTime() - row.createdAt.getTime()),
      );
      continue;
    }
    if (row.status === BookingStatus.CANCELLED) {
      withdrawn += 1;
      continue;
    }
    if (row.status === BookingStatus.EXPIRED) {
      expired += 1;
      continue;
    }
    if (row.status === BookingStatus.PENDING) {
      pending += 1;
      continue;
    }
  }

  const n = turnaroundsMs.length;
  const sortedMs = [...turnaroundsMs].sort((a, b) => a - b);
  const averageHours =
    n > 0 ? turnaroundsMs.reduce((s, t) => s + t, 0) / n / HOUR_MS : null;
  const medianHours =
    n > 0 ? sortedMs[Math.floor((n - 1) / 2)] / HOUR_MS : null;
  const slaMs = SLA_HOURS * HOUR_MS;
  const withinSla = turnaroundsMs.filter((t) => t <= slaMs).length;
  const withinSlaPercent = n > 0 ? (withinSla / n) * 100 : null;

  const [b1, b2, b3] = SLA_BUCKET_BOUNDS_HOURS; // [2, 12, 24]
  const bucketDefs: {
    bucket: ReportSlaBucket;
    test: (t: number) => boolean;
  }[] = [
    { bucket: ReportSlaBucket.UNDER_2H, test: (t) => t < b1 * HOUR_MS },
    {
      bucket: ReportSlaBucket.FROM_2H_TO_12H,
      test: (t) => t >= b1 * HOUR_MS && t < b2 * HOUR_MS,
    },
    {
      bucket: ReportSlaBucket.FROM_12H_TO_24H,
      test: (t) => t >= b2 * HOUR_MS && t <= b3 * HOUR_MS,
    },
    { bucket: ReportSlaBucket.OVER_24H, test: (t) => t > b3 * HOUR_MS },
  ];
  const buckets: ReportSlaBucketRowDto[] = bucketDefs.map(
    ({ bucket, test }) => {
      const count = turnaroundsMs.filter(test).length;
      return { bucket, count, percent: n > 0 ? (count / n) * 100 : 0 };
    },
  );

  return {
    slaHours: SLA_HOURS,
    decided: n,
    decidedApproved,
    decidedRejected,
    averageHours,
    medianHours,
    withinSla,
    withinSlaPercent,
    buckets,
    excluded: { autoRejected, withdrawn, staffCreated, expired, pending },
  };
}

// ── §2.3.5 late-cancellation registry ────────────────────────────────────────────────────────────

export interface RegistrySlot {
  startAt: Date;
  endAt: Date;
  isCancelled: boolean;
  cancelledAt: Date | null;
  cancelledByRole: string | null;
  cancelReason: string | null;
}

export interface RegistrySourceRow {
  code: string;
  venueId: string;
  approvedAt: Date | null;
  slots: readonly RegistrySlot[];
}

export interface RegistryRow {
  code: string;
  slotStartAt: Date;
  slotEndAt: Date;
  lateSlotCount: number;
  cancelledAfterStart: boolean;
  minutes: number;
  venueId: string;
  departmentBucket: number | null;
  canceller: ReportCancellerKind;
  cancelReason: string | null;
}

function cancellerKindOf(role: string | null): ReportCancellerKind {
  if (role === 'LINE_USER') return ReportCancellerKind.REQUESTER;
  if (role === 'SUPER_ADMIN' || role === 'ADMIN')
    return ReportCancellerKind.STAFF;
  return ReportCancellerKind.UNKNOWN;
}

/**
 * D-25: one row per request with `approvedAt ≠ null` whose late-cancelled slots are non-empty.
 * `departmentBucketOfRow` lets the caller apply the D-20 reserved-department fold per row.
 */
export function buildRegistry<R extends RegistrySourceRow>(
  rows: readonly R[],
  leadMs: number,
  departmentBucketOfRow: (row: R) => number | null,
): RegistryRow[] {
  const out: RegistryRow[] = [];
  for (const row of rows) {
    if (row.approvedAt === null) continue;
    const cancelledSlots = row.slots.filter((s) => s.isCancelled);
    const late = lateCancelledSlots(cancelledSlots, leadMs);
    if (late.length === 0) continue;
    const first = late[0]; // slots pre-ordered (startAt, id); filters preserve order -> earliest first.
    const cancelledAfterStart =
      first.cancelledAt !== null &&
      first.cancelledAt.getTime() >= first.startAt.getTime();
    const minutes =
      first.cancelledAt !== null
        ? Math.floor(
            Math.abs(first.startAt.getTime() - first.cancelledAt.getTime()) /
              60_000,
          )
        : 0;
    out.push({
      code: row.code,
      slotStartAt: first.startAt,
      slotEndAt: first.endAt,
      lateSlotCount: late.length,
      cancelledAfterStart,
      minutes,
      venueId: row.venueId,
      departmentBucket: departmentBucketOfRow(row),
      canceller: cancellerKindOf(first.cancelledByRole),
      cancelReason: first.cancelReason,
    });
  }
  out.sort(
    (a, b) =>
      bangkokDate(b.slotStartAt).localeCompare(bangkokDate(a.slotStartAt)) ||
      b.code.localeCompare(a.code),
  );
  return out;
}

/** Maps a built `RegistryRow` + resolved venue/department history to the wire DTO (D-26: no PII). */
export function registryRowToDto(
  row: RegistryRow,
  venue: { name: string; isDeleted: boolean },
  department: { name: string | null; isDeleted: boolean },
): ReportLateCancellationDto {
  return {
    code: row.code,
    slotStartAt: row.slotStartAt,
    slotEndAt: row.slotEndAt,
    lateSlotCount: row.lateSlotCount,
    cancelledAfterStart: row.cancelledAfterStart,
    minutes: row.minutes,
    venueName: venue.name,
    venueIsDeleted: venue.isDeleted,
    departmentName: department.name,
    departmentIsDeleted: department.isDeleted,
    canceller: row.canceller,
    cancelReason: row.cancelReason,
  };
}

// ── §2.3.1/§2.3.2 department fold (D-20) ─────────────────────────────────────────────────────────

/**
 * D-20's reserved-department fold: `null` when unresolvable, or when the department is
 * system-reserved and the actor may not see it (folds into ไม่ระบุกลุ่ม/ฝ่าย).
 */
export function departmentBucketOf(
  effectiveId: number | null,
  byId: ReadonlyMap<number, { isSystemReserved: boolean }>,
  maySeeReserved: boolean,
): number | null {
  if (effectiveId === null) return null;
  const d = byId.get(effectiveId);
  if (!d) return null; // defensive: FK makes this unreachable
  if (d.isSystemReserved && !maySeeReserved) return null;
  return effectiveId;
}

export interface DepartmentSourceRow {
  id: number;
  name: string;
  deletedAt: Date | null;
  isSystemReserved: boolean;
}

export interface DepartmentRequestBucket {
  bucket: number | null;
  status: BookingStatus;
  isLate: boolean;
}

interface DepartmentAgg {
  requests: number;
  approved: number;
  heldMs: number;
  lateCancellations: number;
}

function emptyAgg(): DepartmentAgg {
  return { requests: 0, approved: 0, heldMs: 0, lateCancellations: 0 };
}

function rowOf(
  id: number | null,
  name: string | null,
  isDeleted: boolean,
  a: DepartmentAgg,
  totalHeldMs: number,
): ReportDepartmentRowDto {
  const heldHours = a.heldMs / HOUR_MS;
  return {
    departmentId: id,
    name,
    isDeleted,
    requests: a.requests,
    approved: a.approved,
    approvalPercent: a.requests > 0 ? (a.approved / a.requests) * 100 : null,
    heldHours,
    sharePercent: totalHeldMs > 0 ? (a.heldMs / totalHeldMs) * 100 : 0,
    lateCancellations: a.lateCancellations,
  };
}

/**
 * D-20/D-21: the department table row set + sort. `requestBuckets` and `heldMsByBucket` must both
 * already carry the D-20 fold (via `departmentBucketOf`), so a reserved department never surfaces
 * here for a non-SUPER_ADMIN actor. The `null` (ไม่ระบุกลุ่ม/ฝ่าย) row is always LAST (DV-4).
 */
export function foldDepartments(
  departments: readonly DepartmentSourceRow[],
  requestBuckets: readonly DepartmentRequestBucket[],
  heldMsByBucket: ReadonlyMap<number | null, number>,
  maySeeReserved: boolean,
): ReportDepartmentRowDto[] {
  const agg = new Map<number | null, DepartmentAgg>();
  const bump = (bucket: number | null, patch: Partial<DepartmentAgg>) => {
    const cur = agg.get(bucket) ?? emptyAgg();
    cur.requests += patch.requests ?? 0;
    cur.approved += patch.approved ?? 0;
    cur.heldMs += patch.heldMs ?? 0;
    cur.lateCancellations += patch.lateCancellations ?? 0;
    agg.set(bucket, cur);
  };
  for (const r of requestBuckets) {
    bump(r.bucket, {
      requests: 1,
      approved: r.status === BookingStatus.APPROVED ? 1 : 0,
      lateCancellations: r.isLate ? 1 : 0,
    });
  }
  for (const [bucket, ms] of heldMsByBucket) bump(bucket, { heldMs: ms });

  const totalHeldMs = [...agg.values()].reduce((s, a) => s + a.heldMs, 0);
  const rows: ReportDepartmentRowDto[] = [];

  for (const d of departments) {
    if (d.deletedAt !== null) continue;
    if (d.isSystemReserved && !maySeeReserved) continue;
    rows.push(
      rowOf(d.id, d.name, false, agg.get(d.id) ?? emptyAgg(), totalHeldMs),
    );
  }
  for (const d of departments) {
    if (d.deletedAt === null) continue;
    if (d.isSystemReserved && !maySeeReserved) continue;
    const a = agg.get(d.id);
    if (!a || (a.requests === 0 && a.heldMs === 0 && a.lateCancellations === 0))
      continue;
    rows.push(rowOf(d.id, d.name, true, a, totalHeldMs));
  }

  rows.sort(
    (a, b) =>
      b.heldHours - a.heldHours ||
      b.requests - a.requests ||
      (a.name ?? '').localeCompare(b.name ?? '', 'th'),
  );

  const nullAgg = agg.get(null);
  if (
    nullAgg &&
    (nullAgg.requests > 0 ||
      nullAgg.heldMs > 0 ||
      nullAgg.lateCancellations > 0)
  ) {
    rows.push(rowOf(null, null, false, nullAgg, totalHeldMs));
  }
  return rows;
}
