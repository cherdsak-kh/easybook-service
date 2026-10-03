import { BookingStatus } from '@prisma/client';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import {
  buildReportDocument,
  ledgerStatusOf,
  ledgerWhenOf,
  peakOf,
  type LedgerSource,
  type ReportDocumentInput,
} from './report-document';
import { ReportDocAlign } from './dto/report-document.dto';
import { ReportPeriod, ReportTemplate } from './dto/reports-export-query.dto';
import type { ReportDepartmentRowDto } from './dto/reports-operations-response.dto';
import type { ReportVenueRowDto } from './dto/reports-venues-response.dto';

const bkk = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - 7 * 3_600_000);
const WEEK = 7 * 24 * 3_600_000;
const NOW = bkk(2026, 10, 3, 10, 15);

const zeroCells = () =>
  Array.from({ length: 40 }, () => ({ heldHours: 0, segments: 0 }));

const venue = (over: Partial<ReportVenueRowDto> = {}): ReportVenueRowDto => ({
  venueId: 'v1',
  name: 'หอประชุม',
  typeName: 'ห้องประชุม',
  capacity: 1200,
  isOpen: true,
  isDeleted: false,
  heldHours: 12,
  occupancyPercent: 45.7,
  requests: 5,
  approved: 3,
  autoRejected: 1,
  autoRejectedPercent: 20,
  cells: zeroCells(),
  topClash: null,
  ...over,
});

const dept = (
  over: Partial<ReportDepartmentRowDto> = {},
): ReportDepartmentRowDto => ({
  departmentId: 1,
  name: 'ฝ่ายวิชาการ',
  isDeleted: false,
  requests: 10,
  approved: 8,
  approvalPercent: 80,
  heldHours: 20.25,
  sharePercent: 60,
  lateCancellations: 1,
  ...over,
});

const slot = (startAt: Date, endAt: Date, over = {}) => ({
  startAt,
  endAt,
  isCancelled: false,
  cancelledAt: null,
  ...over,
});

const ledgerRow = (over: Partial<LedgerSource> = {}): LedgerSource => ({
  code: 'BR-25690928-001',
  status: BookingStatus.APPROVED,
  rejectReason: null,
  approvedAt: bkk(2026, 9, 27, 9),
  firstStartAt: bkk(2026, 9, 28, 8, 30),
  purpose: 'ประชุมครู',
  venueId: 'v1',
  departmentId: null,
  lineUser: null,
  slots: [slot(bkk(2026, 9, 28, 8, 30), bkk(2026, 9, 28, 10, 30))],
  ...over,
});

const input = (
  over: Partial<ReportDocumentInput> = {},
): ReportDocumentInput => ({
  template: ReportTemplate.SUMMARY,
  period: ReportPeriod.TERM,
  startDate: '2026-05-16',
  endDate: '2026-10-31',
  now: NOW,
  periodLabel: 'ประจำภาคเรียนที่ 1 ปีการศึกษา 2569',
  venueScopeName: null,
  departmentScopeName: null,
  requests: {
    total: 20,
    approved: 12,
    approvedPercent: 60,
    rejected: 4,
    rejectedPercent: 20,
    autoRejected: 3,
    cancelled: 2,
    cancelledPercent: 10,
    expired: 1,
    expiredPercent: 5,
    pending: 1,
    pendingPercent: 5,
  },
  occupancy: {
    heldHours: 1234.5,
    schoolDays: 90,
    venueCount: 4,
    occupancyPercent: 42.9,
  },
  discipline: {
    lateCancellations: 2,
    noShows: null,
    grantedRequests: 12,
    lateCancellationPercent: 16.666,
    cancelLeadMinutes: 30,
  },
  sla: {
    slaHours: 24,
    decided: 3,
    decidedApproved: 2,
    decidedRejected: 1,
    averageHours: 5.55,
    medianHours: 3,
    withinSla: 3,
    withinSlaPercent: 100,
    buckets: [],
    excluded: {
      autoRejected: 0,
      withdrawn: 0,
      staffCreated: 0,
      expired: 0,
      pending: 0,
    },
  },
  venueRows: [venue()],
  departmentRows: [
    dept(),
    dept({
      departmentId: null,
      name: null,
      requests: 1,
      approvalPercent: null,
    }),
  ],
  mainUserByVenue: new Map(),
  ledger: [],
  venueById: new Map([['v1', { name: 'หอประชุม', deletedAt: null }]]),
  departmentById: new Map([
    [1, { name: 'ฝ่ายวิชาการ', isSystemReserved: false }],
  ]),
  maySeeReserved: false,
  leadMs: 30 * 60_000,
  isEmpty: false,
  ...over,
});

const cellsOf = (doc: ReturnType<typeof buildReportDocument>) =>
  doc.sections.flatMap((s) => s.rows.flatMap((r) => r.cells));

describe('buildReportDocument', () => {
  describe('header and frame (AC-E5)', () => {
    it('carries the six centred lines, the footer and the file name for แบบ 1', () => {
      const doc = buildReportDocument(input());
      expect(doc.header).toEqual({
        title: 'แบบสรุปรายงานสถิติการใช้สถานที่จัดกิจกรรม',
        school:
          'โรงเรียนเทศบาลท่าโขลง 1 สังกัดเทศบาลเมืองท่าโขลง จังหวัดปทุมธานี',
        period: 'ประจำภาคเรียนที่ 1 ปีการศึกษา 2569',
        kind: '(แบบ 1 สรุปภาพรวม)',
        dateRange: 'ข้อมูลระหว่างวันที่ 16 พ.ค. 2569 ถึงวันที่ 31 ต.ค. 2569',
        scope: 'สำหรับขอบเขตข้อมูลสถานที่ทั้งหมด และกลุ่มสาระและฝ่ายงานทั้งหมด',
      });
      expect(doc.footer).toBe(
        'ข้อมูล ณ วันที่ 3 ต.ค. 2569 เอกสารออกโดยระบบ EasyBook',
      );
      expect(doc.fileName).toBe(
        'easybook-report-summary_2026-05-16_2026-10-31.xlsx',
      );
    });

    it('names the PO templates and titles per template', () => {
      expect(
        buildReportDocument(input({ template: ReportTemplate.LEDGER })).header
          .kind,
      ).toBe('(แบบ 2 บัญชีคำขอจอง)');
      expect(
        buildReportDocument(input({ template: ReportTemplate.VENUES })).header
          .kind,
      ).toBe('(แบบ 3 สถิติรายสถานที่)');
      expect(
        buildReportDocument(input({ template: ReportTemplate.LEDGER })).header
          .title,
      ).toBe('บัญชีประวัติการขอใช้สถานที่จัดกิจกรรม');
      expect(
        buildReportDocument(input({ template: ReportTemplate.VENUES })).header
          .title,
      ).toBe('รายงานการใช้สถานที่จัดกิจกรรมรายห้อง');
    });

    it('states a venue and department scope', () => {
      const doc = buildReportDocument(
        input({
          venueScopeName: 'หอประชุม',
          departmentScopeName: 'ฝ่ายวิชาการ',
        }),
      );
      expect(doc.header.scope).toBe(
        'สำหรับขอบเขตข้อมูลสถานที่หอประชุม และฝ่ายวิชาการ',
      );
    });

    it('date uses Bangkok today, not the process zone (22:30 UTC is already tomorrow in Bangkok)', () => {
      const doc = buildReportDocument(
        input({ now: new Date('2026-10-03T22:30:00Z') }),
      );
      expect(doc.footer).toContain('4 ต.ค. 2569');
    });
  });

  describe('typesetting rule over every non-free-text string (D-7)', () => {
    const docs = [
      ReportTemplate.SUMMARY,
      ReportTemplate.LEDGER,
      ReportTemplate.VENUES,
    ].map((template) =>
      buildReportDocument(
        input({
          template,
          ledger: [
            ledgerRow({
              slots: [
                slot(bkk(2026, 9, 28, 8, 30), bkk(2026, 9, 28, 10, 30)),
                slot(
                  new Date(bkk(2026, 9, 28, 8, 30).getTime() + WEEK),
                  new Date(bkk(2026, 9, 28, 10, 30).getTime() + WEEK),
                ),
              ],
            }),
          ],
          venueRows: [
            venue({
              cells: zeroCells().map((c, i) =>
                i === 1 ? { heldHours: 3, segments: 2 } : c,
              ),
            }),
          ],
          mainUserByVenue: new Map([
            ['v1', { name: 'ฝ่ายวิชาการ', fraction: 0.62 }],
          ]),
        }),
      ),
    );

    it.each(docs.map((d) => [d.header.kind, d] as const))(
      '%s has no colon, en dash, em dash or middle dot',
      (_k: string, doc: ReturnType<typeof buildReportDocument>) => {
        const strings = [
          ...(Object.values(doc.header) as string[]),
          doc.footer,
          ...doc.sections.flatMap((s) => [
            s.title,
            s.emptyText,
            ...s.columns.map((c) => c.label),
          ]),
          // The purpose column is free text: a typed colon is data.
          ...doc.sections.flatMap((s) =>
            s.rows.flatMap((r) =>
              r.cells
                .filter((_c, i) => s.columns[i].label !== 'วัตถุประสงค์')
                .map((c) => c.text),
            ),
          ),
        ];
        for (const text of strings) expect(text).not.toMatch(/[:–—·]/);
      },
    );

    it.each(docs.map((d) => [d.header.kind, d] as const))(
      '%s writes every year in BE and every clock as HH.MM น.',
      (_k: string, doc: ReturnType<typeof buildReportDocument>) => {
        const all = [
          ...(Object.values(doc.header) as string[]),
          doc.footer,
          ...doc.sections.flatMap((s) =>
            s.rows.flatMap((r) => r.cells.map((c) => c.text)),
          ),
        ].join('\n');
        for (const year of all.match(/\b(19|20|25)\d{2}\b/g) ?? []) {
          expect(year.startsWith('25')).toBe(true);
        }
        for (const m of all.matchAll(/\d{1,2}[.:]\d{2} น\./g)) {
          expect(m[0]).toMatch(/^\d{2}\.\d{2} น\.$/);
        }
      },
    );

    it('writes an empty cell as - (never blank)', () => {
      const doc = buildReportDocument(
        input({
          sla: { ...input().sla, averageHours: null, withinSlaPercent: null },
        }),
      );
      const sla = doc.sections[0].rows[7];
      expect(sla.cells[1]).toEqual({ text: '-', value: null, numFmt: null });
      expect(sla.cells[2].text).toBe('ไม่มีคำขอที่เจ้าหน้าที่พิจารณา');
      for (const c of cellsOf(doc)) expect(c.text).not.toBe('');
    });
  });

  describe('แบบ 1 (AC-E6)', () => {
    const doc = buildReportDocument(input());
    const [indicators, venues, depts] = doc.sections;

    it('has the three sections in order', () => {
      expect(doc.sections.map((s) => s.title)).toEqual([
        'ตัวชี้วัดหลัก',
        'สถิติการใช้สถานที่รายห้อง',
        'การจัดสรรสถานที่ตามกลุ่มสาระ/ฝ่ายงาน',
      ]);
    });

    it('has the 8 indicator rows', () => {
      expect(indicators.rows.map((r) => r.cells[0].text)).toEqual([
        'คำขอใช้สถานที่ทั้งหมด',
        'อนุมัติ',
        'ปฏิเสธ',
        'ยกเลิก',
        'ชั่วโมงการใช้สถานที่',
        'อัตราการใช้สถานที่',
        'การผิดวินัยการใช้งาน',
        'ระยะเวลาพิจารณาคำขอเฉลี่ย',
      ]);
    });

    it('types the figures: numeric cells carry value + numFmt, and text equals what paper prints', () => {
      const [total, approved, rejected, cancelled, hours, occ, disc, sla] =
        indicators.rows;
      expect(total.cells[1]).toEqual({
        text: '20 รายการ',
        value: 20,
        numFmt: '#,##0" รายการ"',
      });
      expect(approved.cells[1].value).toBe(12);
      expect(approved.cells[2].text).toBe('60.0%');
      expect(rejected.cells[2].text).toBe(
        '20.0% (เวลาชนกับการจองเดิม 3 รายการ)',
      );
      expect(cancelled.cells[2].text).toBe('10.0%');
      expect(hours.cells[1]).toEqual({
        text: '1,234.5 ชั่วโมง',
        value: 1234.5,
        numFmt: '#,##0.0" ชั่วโมง"',
      });
      expect(hours.cells[2].text).toBe('90 วันทำการ');
      expect(occ.cells[1]).toEqual({
        text: '42.9%',
        value: 0.429,
        numFmt: '0.0%',
      });
      expect(occ.cells[2].text).toBe(
        'เทียบกับเวลาเปิดทำการ วันจันทร์ถึงวันศุกร์ เวลา 08.30 ถึง 16.30 น. จำนวน 4 สถานที่',
      );
      expect(sla.cells[1].text).toBe('5.6 ชั่วโมง');
      expect(sla.cells[2].text).toBe('100.0% พิจารณาภายใน 24 ชั่วโมง');
      expect(disc.cells[1].text).toBe('2 ครั้ง');
    });

    it('row 1 reconciles to the total by naming expired and pending when present (DV-5)', () => {
      expect(indicators.rows[0].cells[2].text).toBe(
        'นับตามวันแรกที่ใช้สถานที่ รวมหมดอายุ 1 รายการ และรอพิจารณา 1 รายการ',
      );
      const plain = buildReportDocument(
        input({ requests: { ...input().requests, expired: 0, pending: 0 } }),
      );
      expect(plain.sections[0].rows[0].cells[2].text).toBe(
        'นับตามวันแรกที่ใช้สถานที่',
      );
    });

    it('never prints a no-show count: it is - with the note that the system does not record it (D-6)', () => {
      const note = indicators.rows[6].cells[2].text;
      expect(note).toContain(
        'ไม่มาใช้สถานที่ - ระบบยังไม่บันทึกการเข้าใช้จริง',
      );
      expect(note).toContain('ยกเลิกกระชั้นชิด 2 ครั้ง');
      expect(note.startsWith('16.7% ของการจองที่อนุมัติ')).toBe(true);
    });

    it('a null occupancy is a - text cell, not 0%', () => {
      const d = buildReportDocument(
        input({ occupancy: { ...input().occupancy, occupancyPercent: null } }),
      );
      expect(d.sections[0].rows[5].cells[1]).toEqual({
        text: '-',
        value: null,
        numFmt: null,
      });
    });

    it('lists venues and departments with numbered rows, share and approval rate', () => {
      expect(venues.rows[0].cells.map((c) => c.text)).toEqual([
        '1',
        'หอประชุม',
        '5',
        '12.0',
        '45.7%',
      ]);
      expect(depts.rows[0].cells.map((c) => c.text)).toEqual([
        '1',
        'ฝ่ายวิชาการ',
        '10',
        '20.3',
        '60.0%',
        '80%',
      ]);
      // The null bucket is named, and a null approval rate is -.
      expect(depts.rows[1].cells.map((c) => c.text)).toEqual([
        '2',
        'ไม่ระบุกลุ่ม/ฝ่าย',
        '1',
        '20.3',
        '60.0%',
        '-',
      ]);
    });

    it('marks a deleted department', () => {
      const d = buildReportDocument(
        input({ departmentRows: [dept({ isDeleted: true })] }),
      );
      expect(d.sections[2].rows[0].cells[1].text).toBe('ฝ่ายวิชาการ (ลบแล้ว)');
    });

    it('an empty table prints its emptyText, which the sheet shows in one row', () => {
      const d = buildReportDocument(
        input({ venueRows: [], departmentRows: [] }),
      );
      expect(d.sections[1].rows).toHaveLength(0);
      expect(d.sections[1].emptyText).toBe(
        'ไม่มีรายการในช่วงเวลาและขอบเขตที่เลือก',
      );
    });
  });

  describe('แบบ 2 ledger (AC-E7)', () => {
    const build = (ledger: LedgerSource[]) =>
      buildReportDocument(input({ template: ReportTemplate.LEDGER, ledger }));

    it('has one section and seven columns with the right alignments', () => {
      const doc = build([]);
      expect(doc.sections).toHaveLength(1);
      expect(doc.sections[0].title).toBe(
        'บัญชีคำขอใช้สถานที่ เรียงตามวันที่ใช้',
      );
      expect(doc.sections[0].columns.map((c) => [c.label, c.align])).toEqual([
        ['ลำดับ', ReportDocAlign.CENTER],
        ['รหัสคำขอ', ReportDocAlign.MONO],
        ['วันที่ใช้', ReportDocAlign.TEXT],
        ['สถานที่', ReportDocAlign.TEXT],
        ['กลุ่ม/ฝ่ายผู้ขอ', ReportDocAlign.TEXT],
        ['วัตถุประสงค์', ReportDocAlign.TEXT],
        ['สถานะ', ReportDocAlign.NOWRAP],
      ]);
    });

    it('sorts by first use then code, and numbers the rows', () => {
      const a = ledgerRow({
        code: 'BR-B',
        firstStartAt: bkk(2026, 9, 29, 9),
        slots: [slot(bkk(2026, 9, 29, 9), bkk(2026, 9, 29, 10))],
      });
      const b = ledgerRow({
        code: 'BR-A',
        firstStartAt: bkk(2026, 9, 29, 9),
        slots: [slot(bkk(2026, 9, 29, 9), bkk(2026, 9, 29, 10))],
      });
      const c = ledgerRow({
        code: 'BR-Z',
        firstStartAt: bkk(2026, 9, 28, 9),
        slots: [slot(bkk(2026, 9, 28, 9), bkk(2026, 9, 28, 10))],
      });
      const doc = build([a, b, c]);
      expect(
        doc.sections[0].rows.map((r) => [r.cells[0].text, r.cells[1].text]),
      ).toEqual([
        ['1', 'BR-Z'],
        ['2', 'BR-A'],
        ['3', 'BR-B'],
      ]);
    });

    it('renders the use date with Bangkok times, venue, folded department and the raw purpose', () => {
      const doc = build([
        ledgerRow({
          purpose: '=HYPERLINK("http://evil","x")',
          departmentId: 1,
        }),
      ]);
      const cells = doc.sections[0].rows[0].cells.map((c) => c.text);
      expect(cells).toEqual([
        '1',
        'BR-25690928-001',
        '28 ก.ย. 2569 เวลา 08.30 น. ถึง 10.30 น.',
        'หอประชุม',
        'ฝ่ายวิชาการ',
        '=HYPERLINK("http://evil","x")', // free text is untouched; the cell is a STRING cell in the xlsx
        'อนุมัติแล้ว',
      ]);
      expect(doc.sections[0].rows[0].cells[5].value).toBeNull();
    });

    it('folds a reserved department to ไม่ระบุกลุ่ม/ฝ่าย unless the caller may see it', () => {
      const departmentById = new Map([
        [9, { name: 'System Developer', isSystemReserved: true }],
      ]);
      const row = ledgerRow({ departmentId: 9 });
      const folded = buildReportDocument(
        input({
          template: ReportTemplate.LEDGER,
          ledger: [row],
          departmentById,
        }),
      );
      expect(folded.sections[0].rows[0].cells[4].text).toBe(
        'ไม่ระบุกลุ่ม/ฝ่าย',
      );
      expect(JSON.stringify(folded)).not.toContain('System Developer');
      const seen = buildReportDocument(
        input({
          template: ReportTemplate.LEDGER,
          ledger: [row],
          departmentById,
          maySeeReserved: true,
        }),
      );
      expect(seen.sections[0].rows[0].cells[4].text).toBe('System Developer');
    });

    it('marks a deleted venue and keeps the id when the venue is unknown', () => {
      const venueById = new Map([
        ['v1', { name: 'ห้องเก่า', deletedAt: new Date() }],
      ]);
      const doc = buildReportDocument(
        input({
          template: ReportTemplate.LEDGER,
          ledger: [ledgerRow(), ledgerRow({ code: 'BR-2', venueId: 'gone' })],
          venueById,
        }),
      );
      // BR-2 sorts before BR-25690928-001 (same first use, then code).
      expect(doc.sections[0].rows[0].cells[3].text).toBe('gone');
      expect(doc.sections[0].rows[1].cells[3].text).toBe('ห้องเก่า (ลบแล้ว)');
    });

    describe('status labels', () => {
      const lead = 30 * 60_000;
      const cancelled = (at: Date) =>
        ledgerRow({
          status: BookingStatus.CANCELLED,
          slots: [
            slot(bkk(2026, 9, 28, 9), bkk(2026, 9, 28, 10), {
              isCancelled: true,
              cancelledAt: at,
            }),
          ],
        });
      it.each([
        ['APPROVED', ledgerRow(), 'อนุมัติแล้ว'],
        [
          'auto-rejected',
          ledgerRow({
            status: BookingStatus.REJECTED,
            rejectReason: AUTO_REJECTED_REASON,
            approvedAt: null,
          }),
          'ปฏิเสธ (เวลาชน)',
        ],
        [
          'manual reject',
          ledgerRow({
            status: BookingStatus.REJECTED,
            rejectReason: 'ไม่ว่าง',
            approvedAt: null,
          }),
          'ปฏิเสธ',
        ],
        [
          'reject with no reason',
          ledgerRow({
            status: BookingStatus.REJECTED,
            rejectReason: null,
            approvedAt: null,
          }),
          'ปฏิเสธ',
        ],
        [
          'EXPIRED',
          ledgerRow({ status: BookingStatus.EXPIRED, approvedAt: null }),
          'หมดอายุ',
        ],
        [
          'PENDING',
          ledgerRow({ status: BookingStatus.PENDING, approvedAt: null }),
          'รอพิจารณา',
        ],
        ['cancelled well ahead', cancelled(bkk(2026, 9, 26, 9)), 'ยกเลิก'],
        [
          'cancelled inside the lead window',
          cancelled(bkk(2026, 9, 28, 8, 45)),
          'ยกเลิกกระชั้นชิด',
        ],
        [
          'cancelled after the start',
          cancelled(bkk(2026, 9, 28, 9, 30)),
          'ยกเลิกกระชั้นชิด',
        ],
        [
          'withdrawn while pending (never approved)',
          { ...cancelled(bkk(2026, 9, 28, 8, 45)), approvedAt: null },
          'ยกเลิก',
        ],
      ])('%s', (_l, row, label) => {
        expect(ledgerStatusOf(row, lead)).toBe(label);
      });
    });

    describe('use-date suffix (DV-6)', () => {
      const s0 = bkk(2026, 9, 28, 8, 30);
      const mk = (offsetsMs: number[]) =>
        ledgerRow({
          slots: offsetsMs.map((o) =>
            slot(
              new Date(s0.getTime() + o),
              new Date(s0.getTime() + o + 2 * 3_600_000),
            ),
          ),
        });
      it('a single slot has no suffix', () => {
        expect(ledgerWhenOf(mk([0]))).toBe(
          '28 ก.ย. 2569 เวลา 08.30 น. ถึง 10.30 น.',
        );
      });
      it('exactly weekly slots read (ทุกสัปดาห์ จำนวน N สัปดาห์)', () => {
        expect(ledgerWhenOf(mk([0, WEEK, 2 * WEEK]))).toBe(
          '28 ก.ย. 2569 เวลา 08.30 น. ถึง 10.30 น. (ทุกสัปดาห์ จำนวน 3 สัปดาห์)',
        );
      });
      it('anything else reads (รวม N ช่วงเวลา) because "every week" on an official paper must be true', () => {
        expect(ledgerWhenOf(mk([0, WEEK, 3 * WEEK]))).toContain(
          '(รวม 3 ช่วงเวลา)',
        );
        expect(ledgerWhenOf(mk([0, 24 * 3_600_000]))).toContain(
          '(รวม 2 ช่วงเวลา)',
        );
      });
      it('shows the slot that starts at firstStartAt, else the first slot', () => {
        const row = ledgerRow({
          firstStartAt: new Date(s0.getTime() + WEEK),
          slots: [
            slot(s0, new Date(s0.getTime() + 3_600_000)),
            slot(
              new Date(s0.getTime() + WEEK),
              new Date(s0.getTime() + WEEK + 2 * 3_600_000),
            ),
          ],
        });
        expect(ledgerWhenOf(row)).toContain('5 ต.ค. 2569');
      });
      it('a cross-midnight UTC instant still prints the Bangkok date', () => {
        const late = ledgerRow({
          firstStartAt: new Date('2026-09-28T17:30:00Z'), // 00:30 +07 on the 29th
          slots: [
            slot(
              new Date('2026-09-28T17:30:00Z'),
              new Date('2026-09-28T19:00:00Z'),
            ),
          ],
        });
        expect(ledgerWhenOf(late)).toBe(
          '29 ก.ย. 2569 เวลา 00.30 น. ถึง 02.00 น.',
        );
      });
    });
  });

  describe('แบบ 3 venues (AC-E8)', () => {
    it('has nine columns and decorates the venue name, type and capacity', () => {
      const doc = buildReportDocument(
        input({
          template: ReportTemplate.VENUES,
          venueRows: [
            venue(),
            venue({
              venueId: 'v2',
              name: 'ห้องปิด',
              isOpen: false,
              typeName: '',
              capacity: 0,
            }),
            venue({ venueId: 'v3', name: 'ห้องลบ', isDeleted: true }),
          ],
        }),
      );
      expect(doc.sections).toHaveLength(1);
      expect(doc.sections[0].columns).toHaveLength(9);
      const names = doc.sections[0].rows.map((r) => r.cells[1].text);
      expect(names).toEqual([
        'หอประชุม',
        'ห้องปิด (ปิดให้จอง)',
        'ห้องลบ (ลบแล้ว)',
      ]);
      expect(doc.sections[0].rows[0].cells[2].text).toBe(
        'ห้องประชุม ความจุ 1,200 คน',
      );
      expect(doc.sections[0].rows[1].cells[2].text).toBe('-'); // no type, no capacity
    });

    it('shows the busiest weekday and hour, or - when nothing was held', () => {
      const cells = zeroCells();
      cells[1 * 8 + 2] = { heldHours: 5, segments: 3 }; // Tuesday, 10.30
      expect(peakOf(cells)).toBe('วันอังคาร เวลา 10.30 น.');
      expect(peakOf(zeroCells())).toBe('-');
    });

    it('breaks a peak tie to the lowest cell index', () => {
      const cells = zeroCells();
      cells[3 * 8] = { heldHours: 4, segments: 1 };
      cells[1 * 8 + 7] = { heldHours: 4, segments: 1 };
      expect(peakOf(cells)).toBe('วันอังคาร เวลา 15.30 น.');
    });

    it('shows the main user with a rounded share, or -', () => {
      const doc = buildReportDocument(
        input({
          template: ReportTemplate.VENUES,
          venueRows: [venue(), venue({ venueId: 'v2', name: 'อื่น' })],
          mainUserByVenue: new Map([
            ['v1', { name: 'ฝ่ายวิชาการ', fraction: 0.625 }],
          ]),
        }),
      );
      expect(doc.sections[0].rows[0].cells[8].text).toBe('ฝ่ายวิชาการ (63%)');
      expect(doc.sections[0].rows[1].cells[8].text).toBe('-');
    });

    it('types hours and approved/clash counts as numbers', () => {
      const doc = buildReportDocument(
        input({ template: ReportTemplate.VENUES }),
      );
      const r = doc.sections[0].rows[0].cells;
      expect(r[3]).toEqual({ text: '12.0', value: 12, numFmt: '#,##0.0' });
      expect(r[5].value).toBe(3);
      expect(r[6].value).toBe(1);
    });
  });

  it('passes isEmpty through (D-12)', () => {
    expect(buildReportDocument(input({ isEmpty: true })).isEmpty).toBe(true);
    expect(buildReportDocument(input({ isEmpty: false })).isEmpty).toBe(false);
  });
});
