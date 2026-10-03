import { BookingStatus } from '@prisma/client';
import ExcelJS from 'exceljs';
import { buildReportDocument } from './report-document';
import { ReportDocAlign } from './dto/report-document.dto';
import { ReportPeriod, ReportTemplate } from './dto/reports-export-query.dto';
import { widthOf, writeReportXlsx } from './report-xlsx';

const doc = (template: ReportTemplate, purpose = 'ประชุมครู') =>
  buildReportDocument({
    template,
    period: ReportPeriod.CUSTOM,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    now: new Date('2026-10-03T03:15:00Z'),
    periodLabel: 'ระหว่างวันที่ 1 ก.ย. 2569 ถึงวันที่ 30 ก.ย. 2569',
    venueScopeName: null,
    departmentScopeName: null,
    requests: {
      total: 3,
      approved: 2,
      approvedPercent: 66.6667,
      rejected: 1,
      rejectedPercent: 33.3333,
      autoRejected: 0,
      cancelled: 0,
      cancelledPercent: 0,
      expired: 0,
      expiredPercent: 0,
      pending: 0,
      pendingPercent: 0,
    },
    occupancy: {
      heldHours: 12.5,
      schoolDays: 22,
      venueCount: 2,
      occupancyPercent: 7.1,
    },
    discipline: {
      lateCancellations: 0,
      noShows: null,
      grantedRequests: 2,
      lateCancellationPercent: 0,
      cancelLeadMinutes: 30,
    },
    sla: {
      slaHours: 24,
      decided: 0,
      decidedApproved: 0,
      decidedRejected: 0,
      averageHours: null,
      medianHours: null,
      withinSla: 0,
      withinSlaPercent: null,
      buckets: [],
      excluded: {
        autoRejected: 0,
        withdrawn: 0,
        staffCreated: 0,
        expired: 0,
        pending: 0,
      },
    },
    venueRows: [
      {
        venueId: 'v1',
        name: 'หอประชุม',
        typeName: 'ห้องประชุม',
        capacity: 100,
        isOpen: true,
        isDeleted: false,
        heldHours: 12.5,
        occupancyPercent: 7.1,
        requests: 3,
        approved: 2,
        autoRejected: 0,
        autoRejectedPercent: 0,
        cells: Array.from({ length: 40 }, () => ({
          heldHours: 0,
          segments: 0,
        })),
        topClash: null,
      },
    ],
    departmentRows: [],
    mainUserByVenue: new Map(),
    ledger: [
      {
        code: 'BR-1',
        status: BookingStatus.APPROVED,
        rejectReason: null,
        approvedAt: new Date('2026-09-01T00:00:00Z'),
        firstStartAt: new Date('2026-09-10T02:00:00Z'),
        purpose,
        venueId: 'v1',
        departmentId: null,
        lineUser: null,
        slots: [
          {
            startAt: new Date('2026-09-10T02:00:00Z'),
            endAt: new Date('2026-09-10T04:00:00Z'),
            isCancelled: false,
            cancelledAt: null,
          },
        ],
      },
    ],
    venueById: new Map([['v1', { name: 'หอประชุม', deletedAt: null }]]),
    departmentById: new Map(),
    maySeeReserved: false,
    leadMs: 0,
    isEmpty: false,
  });

async function read(template: ReportTemplate, purpose?: string) {
  const model = doc(template, purpose);
  const buffer = await writeReportXlsx({ template, ...model });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return { model, wb, ws: wb.worksheets[0] };
}

describe('writeReportXlsx (AC-E10)', () => {
  it('returns a real OOXML zip', async () => {
    const buf = await writeReportXlsx({
      template: ReportTemplate.SUMMARY,
      ...doc(ReportTemplate.SUMMARY),
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });

  it.each([
    [ReportTemplate.SUMMARY, 'แบบ 1 สรุปภาพรวม'],
    [ReportTemplate.LEDGER, 'แบบ 2 บัญชีคำขอจอง'],
    [ReportTemplate.VENUES, 'แบบ 3 สถิติรายสถานที่'],
  ])(
    '%s: one sheet named %s (<= 31 chars, no forbidden characters), creator EasyBook',
    async (template, name) => {
      const { wb, ws } = await read(template);
      expect(wb.worksheets).toHaveLength(1);
      expect(ws.name).toBe(name);
      expect(name.length).toBeLessThanOrEqual(31);
      expect(name).not.toMatch(/[[\]:*?/\\]/);
      expect(wb.creator).toBe('EasyBook');
    },
  );

  it('sets A4 and portrait for แบบ 1, landscape for แบบ 2/3', async () => {
    expect((await read(ReportTemplate.SUMMARY)).ws.pageSetup).toMatchObject({
      paperSize: 9,
      orientation: 'portrait',
      fitToWidth: 1,
    });
    expect((await read(ReportTemplate.LEDGER)).ws.pageSetup).toMatchObject({
      orientation: 'landscape',
    });
    expect((await read(ReportTemplate.VENUES)).ws.pageSetup).toMatchObject({
      orientation: 'landscape',
    });
  });

  it.each([
    ReportTemplate.SUMMARY,
    ReportTemplate.LEDGER,
    ReportTemplate.VENUES,
  ])('%s: the workbook equals the model cell for cell', async (template) => {
    const { model, ws } = await read(template);
    let r = 1;
    const textAt = (row: number, col = 1) => {
      const v = ws.getCell(row, col).value;
      return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    };
    for (const line of [
      model.header.title,
      model.header.school,
      model.header.period,
      model.header.kind,
      model.header.dateRange,
      model.header.scope,
    ]) {
      expect(textAt(r)).toBe(line);
      r += 1;
    }
    r += 1; // blank row
    model.sections.forEach((section, si) => {
      expect(textAt(r)).toBe(`${si + 1}. ${section.title}`);
      r += 1;
      section.columns.forEach((c, ci) =>
        expect(ws.getCell(r, ci + 1).value).toBe(c.label),
      );
      r += 1;
      if (section.rows.length === 0) {
        expect(textAt(r)).toBe(section.emptyText);
        r += 1;
      }
      for (const row of section.rows) {
        row.cells.forEach((cell, ci) => {
          const got = ws.getCell(r, ci + 1);
          if (cell.value !== null) {
            expect(typeof got.value).toBe('number');
            expect(got.value).toBe(cell.value);
            expect(got.numFmt).toBe(cell.numFmt);
          } else {
            expect(typeof got.value).toBe('string');
            expect(got.value).toBe(cell.text);
          }
        });
        r += 1;
      }
      r += 1; // blank row after the section
    });
    expect(textAt(r)).toBe(model.footer);
  });

  it('writes a purpose that begins with = as an inert STRING cell, never a formula', async () => {
    const evil = '=HYPERLINK("http://evil.example","click")';
    const { ws } = await read(ReportTemplate.LEDGER, evil);
    let found = false;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value === evil) {
          found = true;
          expect(typeof cell.value).toBe('string');
          expect(cell.type).toBe(ExcelJS.ValueType.String);
          expect(cell.formula).toBeUndefined();
        }
      });
    });
    expect(found).toBe(true);
  });

  it.each(['+1+1', '-2+3', '@SUM(A1)'])('keeps %s as text', async (purpose) => {
    const { ws } = await read(ReportTemplate.LEDGER, purpose);
    let type: ExcelJS.ValueType | undefined;
    ws.eachRow((row) =>
      row.eachCell((c) => {
        if (c.value === purpose) type = c.type;
      }),
    );
    expect(type).toBe(ExcelJS.ValueType.String);
  });

  it('writes numbers as numeric cells that Excel can SUM', async () => {
    const { ws } = await read(ReportTemplate.VENUES);
    const hours = ws.getCell(10, 4); // 6 header lines, blank, section title, column heads, first row
    expect(typeof hours.value).toBe('number');
    expect(hours.numFmt).toBe('#,##0.0');
  });

  it('merges the header lines across the widest section and centres them', async () => {
    const { ws } = await read(ReportTemplate.SUMMARY);
    expect(ws.getCell(1, 1).alignment?.horizontal).toBe('center');
    expect(ws.getCell(1, 1).font?.bold).toBe(true);
    expect(ws.getCell(1, 1).font?.name).toBe('TH Sarabun PSK');
    expect(ws.getCell(1, 1).isMerged).toBe(true);
    expect(ws.getCell(1, 6).isMerged).toBe(true);
  });

  it('widthOf clamps to 6..60', () => {
    expect(widthOf(0)).toBe(6);
    expect(widthOf(10)).toBe(14);
    expect(widthOf(500)).toBe(60);
  });

  it('uses the ReportDocAlign values the sheet understands', () => {
    expect(Object.values(ReportDocAlign)).toEqual([
      'TEXT',
      'NUM',
      'CENTER',
      'MONO',
      'NOWRAP',
    ]);
  });
});
