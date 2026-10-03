import { BookingStatus } from '@prisma/client';
import { effectiveDepartmentIdOf } from '../bookings/booking-list-view';
import { bangkokDate, HOUR_MS } from './report-calendar';
import { isAutoRejected, lateCancelledSlots } from './report-fold';
import { departmentBucketOf } from './report-operations';
import {
  REPORT_EMPTY_TABLE_TEXT,
  REPORT_NO_BUCKET_LABEL,
  REPORT_SCHOOL_LINE,
} from './report-export.constants';
import {
  docClock,
  docClockOfMinutes,
  docHours,
  docInt,
  docPercent,
  THAI_WEEKDAYS_MON_FIRST,
  thaiDateShort,
} from './report-thai';
import {
  ReportDocAlign,
  type ReportDocCellDto,
  type ReportDocColumnDto,
  type ReportDocHeaderDto,
  type ReportDocSectionDto,
} from './dto/report-document.dto';
import { ReportPeriod, ReportTemplate } from './dto/reports-export-query.dto';
import type {
  ReportDepartmentRowDto,
  ReportSlaDto,
} from './dto/reports-operations-response.dto';
import type {
  DisciplineDto,
  OccupancyDto,
  RequestBreakdownDto,
} from './dto/reports-overview-response.dto';
import type { ReportVenueRowDto } from './dto/reports-venues-response.dto';
import { HEAT_SLOT_COUNT, SLA_HOURS } from './reports.constants';

/**
 * Hub 4's document builder (design §2.3.2 to §2.3.4). PURE: it turns already-folded figures and rows
 * into the document model. The same model feeds the JSON endpoint (the A4 sheet) and `report-xlsx.ts`
 * (the workbook), so paper and file cannot disagree: nothing is computed twice.
 *
 * Typesetting rule (D-7, AC-E5): Arabic numerals, BE years in `วว ด.ด. ปปปป`, `HH.MM น.` times,
 * `ระหว่างวันที่ ... ถึงวันที่ ...`, empty cells `-`, and none of `:` `–` `—` `·`. Free text a user typed
 * (purpose, venue and department names) is passed through UNCHANGED: a typed colon is data.
 */

export const DOC_EMPTY = '-';

// ── cell helpers ─────────────────────────────────────────────────────────────────────────────────

const text = (t: string): ReportDocCellDto => ({
  text: t === '' ? DOC_EMPTY : t,
  value: null,
  numFmt: null,
});

const numeric = (
  value: number,
  display: string,
  numFmt: string,
): ReportDocCellDto => ({ text: display, value, numFmt });

const intCell = (n: number): ReportDocCellDto => numeric(n, docInt(n), '#,##0');

const unitCell = (n: number, unit: string): ReportDocCellDto =>
  numeric(n, `${docInt(n)} ${unit}`, `#,##0" ${unit}"`);

const hoursCell = (h: number): ReportDocCellDto =>
  numeric(h, docHours(h), '#,##0.0');

/** `percent` is 0 to 100 (the report DTOs' scale). `null` renders `-` as a TEXT cell. */
const percentCell = (
  percent: number | null,
  digits: 0 | 1,
): ReportDocCellDto =>
  percent === null
    ? text(DOC_EMPTY)
    : numeric(
        percent / 100,
        docPercent(percent / 100, digits),
        digits === 0 ? '0%' : '0.0%',
      );

const col = (label: string, align: ReportDocAlign): ReportDocColumnDto => ({
  label,
  align,
});

const row = (...cells: ReportDocCellDto[]) => ({ cells });

const rankCell = (i: number): ReportDocCellDto =>
  numeric(i + 1, String(i + 1), '0');

// ── inputs ───────────────────────────────────────────────────────────────────────────────────────

export interface LedgerSource {
  code: string;
  status: BookingStatus;
  rejectReason: string | null;
  approvedAt: Date | null;
  firstStartAt: Date;
  purpose: string;
  venueId: string;
  departmentId: number | null;
  lineUser: { registration: { departmentId: number } | null } | null;
  slots: ReadonlyArray<{
    startAt: Date;
    endAt: Date;
    isCancelled: boolean;
    cancelledAt: Date | null;
  }>;
}

export interface DocVenueInfo {
  name: string;
  deletedAt: Date | null;
}

export interface DocDepartmentInfo {
  name: string;
  isSystemReserved: boolean;
}

export interface ReportDocumentInput {
  template: ReportTemplate;
  period: ReportPeriod;
  startDate: string;
  endDate: string;
  now: Date;
  periodLabel: string;
  /** `null` = all venues / all departments. */
  venueScopeName: string | null;
  departmentScopeName: string | null;
  requests: RequestBreakdownDto;
  occupancy: OccupancyDto;
  discipline: DisciplineDto;
  sla: ReportSlaDto;
  /** Already scoped and ordered. */
  venueRows: readonly ReportVenueRowDto[];
  departmentRows: readonly ReportDepartmentRowDto[];
  /** Per venue: the non-null department bucket with the most held ms. */
  mainUserByVenue: ReadonlyMap<string, { name: string; fraction: number }>;
  ledger: readonly LedgerSource[];
  venueById: ReadonlyMap<string, DocVenueInfo>;
  departmentById: ReadonlyMap<number, DocDepartmentInfo>;
  maySeeReserved: boolean;
  leadMs: number;
  isEmpty: boolean;
}

export interface ReportDocumentBody {
  isEmpty: boolean;
  header: ReportDocHeaderDto;
  sections: ReportDocSectionDto[];
  footer: string;
  fileName: string;
}

// ── fixed text ───────────────────────────────────────────────────────────────────────────────────

const TEMPLATE_META: Record<
  ReportTemplate,
  { title: string; kind: string; slug: string }
> = {
  [ReportTemplate.SUMMARY]: {
    title: 'แบบสรุปรายงานสถิติการใช้สถานที่จัดกิจกรรม',
    kind: '(แบบ 1 สรุปภาพรวม)',
    slug: 'summary',
  },
  [ReportTemplate.LEDGER]: {
    title: 'บัญชีประวัติการขอใช้สถานที่จัดกิจกรรม',
    kind: '(แบบ 2 บัญชีคำขอจอง)',
    slug: 'ledger',
  },
  [ReportTemplate.VENUES]: {
    title: 'รายงานการใช้สถานที่จัดกิจกรรมรายห้อง',
    kind: '(แบบ 3 สถิติรายสถานที่)',
    slug: 'venues',
  },
};

/** The workbook's sheet name per template (<= 31 chars, none of `[]:*?/\`). */
export const SHEET_NAME: Record<ReportTemplate, string> = {
  [ReportTemplate.SUMMARY]: 'แบบ 1 สรุปภาพรวม',
  [ReportTemplate.LEDGER]: 'แบบ 2 บัญชีคำขอจอง',
  [ReportTemplate.VENUES]: 'แบบ 3 สถิติรายสถานที่',
};

export const fileNameOf = (
  template: ReportTemplate,
  startDate: string,
  endDate: string,
): string =>
  `easybook-report-${TEMPLATE_META[template].slug}_${startDate}_${endDate}.xlsx`;

const DELETED_SUFFIX = ' (ลบแล้ว)';
const WEEK_MS = 7 * 24 * HOUR_MS;

// ── แบบ 1 ────────────────────────────────────────────────────────────────────────────────────────

function keyIndicators(input: ReportDocumentInput): ReportDocSectionDto {
  const { requests: r, occupancy: o, discipline: d, sla } = input;
  const venueCount = o.venueCount;
  const latePct = docPercent(d.lateCancellationPercent / 100, 1);
  const closing =
    r.expired + r.pending > 0
      ? ` รวมหมดอายุ ${r.expired} รายการ และรอพิจารณา ${r.pending} รายการ`
      : '';
  return {
    title: 'ตัวชี้วัดหลัก',
    columns: [
      col('ตัวชี้วัด', ReportDocAlign.TEXT),
      col('จำนวน', ReportDocAlign.NUM),
      col('ร้อยละและหมายเหตุ', ReportDocAlign.TEXT),
    ],
    emptyText: REPORT_EMPTY_TABLE_TEXT,
    rows: [
      row(
        text('คำขอใช้สถานที่ทั้งหมด'),
        unitCell(r.total, 'รายการ'),
        text(`นับตามวันแรกที่ใช้สถานที่${closing}`),
      ),
      row(
        text('อนุมัติ'),
        unitCell(r.approved, 'รายการ'),
        text(docPercent(r.approvedPercent / 100, 1)),
      ),
      row(
        text('ปฏิเสธ'),
        unitCell(r.rejected, 'รายการ'),
        text(
          `${docPercent(r.rejectedPercent / 100, 1)} (เวลาชนกับการจองเดิม ${r.autoRejected} รายการ)`,
        ),
      ),
      row(
        text('ยกเลิก'),
        unitCell(r.cancelled, 'รายการ'),
        text(docPercent(r.cancelledPercent / 100, 1)),
      ),
      row(
        text('ชั่วโมงการใช้สถานที่'),
        numeric(
          o.heldHours,
          `${docHours(o.heldHours)} ชั่วโมง`,
          '#,##0.0" ชั่วโมง"',
        ),
        text(`${o.schoolDays} วันทำการ`),
      ),
      row(
        text('อัตราการใช้สถานที่'),
        percentCell(o.occupancyPercent, 1),
        text(
          `เทียบกับเวลาเปิดทำการ วันจันทร์ถึงวันศุกร์ เวลา 08.30 ถึง 16.30 น. จำนวน ${venueCount} สถานที่`,
        ),
      ),
      row(
        text('การผิดวินัยการใช้งาน'),
        unitCell(d.lateCancellations, 'ครั้ง'),
        text(
          `${latePct} ของการจองที่อนุมัติ (ยกเลิกกระชั้นชิด ${d.lateCancellations} ครั้ง ไม่มาใช้สถานที่ - ระบบยังไม่บันทึกการเข้าใช้จริง)`,
        ),
      ),
      row(
        text('ระยะเวลาพิจารณาคำขอเฉลี่ย'),
        sla.averageHours === null
          ? text(DOC_EMPTY)
          : numeric(
              sla.averageHours,
              `${docHours(sla.averageHours)} ชั่วโมง`,
              '#,##0.0" ชั่วโมง"',
            ),
        text(
          sla.withinSlaPercent === null
            ? 'ไม่มีคำขอที่เจ้าหน้าที่พิจารณา'
            : `${docPercent(sla.withinSlaPercent / 100, 1)} พิจารณาภายใน ${SLA_HOURS} ชั่วโมง`,
        ),
      ),
    ],
  };
}

function venueStatistics(input: ReportDocumentInput): ReportDocSectionDto {
  return {
    title: 'สถิติการใช้สถานที่รายห้อง',
    columns: [
      col('ลำดับ', ReportDocAlign.CENTER),
      col('สถานที่', ReportDocAlign.TEXT),
      col('คำขอ', ReportDocAlign.NUM),
      col('ชั่วโมงที่ใช้', ReportDocAlign.NUM),
      col('อัตราการใช้', ReportDocAlign.NUM),
    ],
    emptyText: REPORT_EMPTY_TABLE_TEXT,
    rows: input.venueRows.map((v, i) =>
      row(
        rankCell(i),
        text(v.name),
        intCell(v.requests),
        hoursCell(v.heldHours),
        percentCell(v.occupancyPercent, 1),
      ),
    ),
  };
}

function departmentAllocation(input: ReportDocumentInput): ReportDocSectionDto {
  return {
    title: 'การจัดสรรสถานที่ตามกลุ่มสาระ/ฝ่ายงาน',
    columns: [
      col('ลำดับ', ReportDocAlign.CENTER),
      col('กลุ่มสาระ/ฝ่ายงาน', ReportDocAlign.TEXT),
      col('คำขอ', ReportDocAlign.NUM),
      col('ชั่วโมงที่ใช้', ReportDocAlign.NUM),
      col('สัดส่วน', ReportDocAlign.NUM),
      col('อัตราอนุมัติ', ReportDocAlign.NUM),
    ],
    emptyText: REPORT_EMPTY_TABLE_TEXT,
    rows: input.departmentRows.map((d, i) =>
      row(
        rankCell(i),
        text(
          d.name === null
            ? REPORT_NO_BUCKET_LABEL
            : `${d.name}${d.isDeleted ? DELETED_SUFFIX : ''}`,
        ),
        intCell(d.requests),
        hoursCell(d.heldHours),
        percentCell(d.sharePercent, 1),
        percentCell(d.approvalPercent, 0),
      ),
    ),
  };
}

// ── แบบ 2 ────────────────────────────────────────────────────────────────────────────────────────

/** The status label of one ledger row (design §2.3.4). */
export function ledgerStatusOf(r: LedgerSource, leadMs: number): string {
  switch (r.status) {
    case BookingStatus.APPROVED:
      return 'อนุมัติแล้ว';
    case BookingStatus.REJECTED:
      return isAutoRejected(r) ? 'ปฏิเสธ (เวลาชน)' : 'ปฏิเสธ';
    case BookingStatus.CANCELLED:
      return r.approvedAt !== null &&
        lateCancelledSlots(
          r.slots.filter((s) => s.isCancelled),
          leadMs,
        ).length > 0
        ? 'ยกเลิกกระชั้นชิด'
        : 'ยกเลิก';
    case BookingStatus.EXPIRED:
      return 'หมดอายุ';
    case BookingStatus.PENDING:
      return 'รอพิจารณา';
  }
}

/** `<date> เวลา 08.30 น. ถึง 10.30 น.` plus the weekly / multi-slot suffix (DV-6). */
export function ledgerWhenOf(r: LedgerSource): string {
  const shown =
    r.slots.find((s) => s.startAt.getTime() === r.firstStartAt.getTime()) ??
    r.slots[0];
  if (!shown) return DOC_EMPTY;
  const base = `${thaiDateShort(bangkokDate(shown.startAt))} เวลา ${docClock(shown.startAt)} ถึง ${docClock(shown.endAt)}`;
  const n = r.slots.length;
  if (n <= 1) return base;
  const starts = r.slots.map((s) => s.startAt.getTime());
  const weekly = starts.every(
    (t, i) => i === 0 || t - starts[i - 1] === WEEK_MS,
  );
  return weekly
    ? `${base} (ทุกสัปดาห์ จำนวน ${n} สัปดาห์)`
    : `${base} (รวม ${n} ช่วงเวลา)`;
}

function ledgerSection(input: ReportDocumentInput): ReportDocSectionDto {
  const sorted = [...input.ledger].sort(
    (a, b) =>
      a.firstStartAt.getTime() - b.firstStartAt.getTime() ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  return {
    title: 'บัญชีคำขอใช้สถานที่ เรียงตามวันที่ใช้',
    columns: [
      col('ลำดับ', ReportDocAlign.CENTER),
      col('รหัสคำขอ', ReportDocAlign.MONO),
      col('วันที่ใช้', ReportDocAlign.TEXT),
      col('สถานที่', ReportDocAlign.TEXT),
      col('กลุ่ม/ฝ่ายผู้ขอ', ReportDocAlign.TEXT),
      col('วัตถุประสงค์', ReportDocAlign.TEXT),
      col('สถานะ', ReportDocAlign.NOWRAP),
    ],
    emptyText: REPORT_EMPTY_TABLE_TEXT,
    rows: sorted.map((r, i) => {
      const venue = input.venueById.get(r.venueId);
      const bucket = departmentBucketOf(
        effectiveDepartmentIdOf(r),
        input.departmentById,
        input.maySeeReserved,
      );
      const dept = bucket === null ? null : input.departmentById.get(bucket);
      return row(
        rankCell(i),
        text(r.code),
        text(ledgerWhenOf(r)),
        text(
          venue
            ? `${venue.name}${venue.deletedAt ? DELETED_SUFFIX : ''}`
            : r.venueId,
        ),
        text(dept ? dept.name : REPORT_NO_BUCKET_LABEL),
        text(r.purpose),
        text(ledgerStatusOf(r, input.leadMs)),
      );
    }),
  };
}

// ── แบบ 3 ────────────────────────────────────────────────────────────────────────────────────────

/** The busiest weekday/hour cell (lowest index on a tie), or `-` when every cell is 0. */
export function peakOf(cells: ReportVenueRowDto['cells']): string {
  let best = -1;
  let bestHours = 0;
  cells.forEach((c, i) => {
    if (c.heldHours > bestHours) {
      bestHours = c.heldHours;
      best = i;
    }
  });
  if (best < 0) return DOC_EMPTY;
  const weekday = Math.floor(best / HEAT_SLOT_COUNT);
  const slot = best % HEAT_SLOT_COUNT;
  return `วัน${THAI_WEEKDAYS_MON_FIRST[weekday]} เวลา ${docClockOfMinutes(8 * 60 + 30 + slot * 60)}`;
}

function venueTable(input: ReportDocumentInput): ReportDocSectionDto {
  return {
    title: 'การใช้สถานที่รายห้อง',
    columns: [
      col('ลำดับ', ReportDocAlign.CENTER),
      col('สถานที่', ReportDocAlign.TEXT),
      col('ประเภทและความจุ', ReportDocAlign.TEXT),
      col('ชั่วโมงที่ใช้', ReportDocAlign.NUM),
      col('อัตราการใช้', ReportDocAlign.NUM),
      col('อนุมัติ', ReportDocAlign.NUM),
      col('ชนเวลา', ReportDocAlign.NUM),
      col('ช่วงที่ใช้มากที่สุด', ReportDocAlign.NOWRAP),
      col('ผู้ใช้หลัก', ReportDocAlign.TEXT),
    ],
    emptyText: REPORT_EMPTY_TABLE_TEXT,
    rows: input.venueRows.map((v, i) => {
      const main = input.mainUserByVenue.get(v.venueId);
      const suffix = v.isDeleted
        ? DELETED_SUFFIX
        : v.isOpen
          ? ''
          : ' (ปิดให้จอง)';
      const capacity = v.capacity > 0 ? ` ความจุ ${docInt(v.capacity)} คน` : '';
      return row(
        rankCell(i),
        text(`${v.name}${suffix}`),
        text(`${v.typeName}${capacity}`.trim()),
        hoursCell(v.heldHours),
        percentCell(v.occupancyPercent, 1),
        intCell(v.approved),
        intCell(v.autoRejected),
        text(peakOf(v.cells)),
        text(
          main ? `${main.name} (${docPercent(main.fraction, 0)})` : DOC_EMPTY,
        ),
      );
    }),
  };
}

// ── assembly ─────────────────────────────────────────────────────────────────────────────────────

export function buildReportDocument(
  input: ReportDocumentInput,
): ReportDocumentBody {
  const meta = TEMPLATE_META[input.template];
  const venuePart =
    input.venueScopeName === null
      ? 'สถานที่ทั้งหมด'
      : `สถานที่${input.venueScopeName}`;
  const deptPart =
    input.departmentScopeName === null
      ? 'กลุ่มสาระและฝ่ายงานทั้งหมด'
      : input.departmentScopeName;

  const sections =
    input.template === ReportTemplate.SUMMARY
      ? [
          keyIndicators(input),
          venueStatistics(input),
          departmentAllocation(input),
        ]
      : input.template === ReportTemplate.LEDGER
        ? [ledgerSection(input)]
        : [venueTable(input)];

  return {
    isEmpty: input.isEmpty,
    header: {
      title: meta.title,
      school: REPORT_SCHOOL_LINE,
      period: input.periodLabel,
      kind: meta.kind,
      dateRange: `ข้อมูลระหว่างวันที่ ${thaiDateShort(input.startDate)} ถึงวันที่ ${thaiDateShort(input.endDate)}`,
      scope: `สำหรับขอบเขตข้อมูล${venuePart} และ${deptPart}`,
    },
    sections,
    footer: `ข้อมูล ณ วันที่ ${thaiDateShort(bangkokDate(input.now))} เอกสารออกโดยระบบ EasyBook`,
    fileName: fileNameOf(input.template, input.startDate, input.endDate),
  };
}
