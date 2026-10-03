import ExcelJS from 'exceljs';
import { SHEET_NAME } from './report-document';
import { ReportDocAlign } from './dto/report-document.dto';
import type {
  ReportDocCellDto,
  ReportDocumentDto,
} from './dto/report-document.dto';
import { ReportTemplate } from './dto/reports-export-query.dto';

/**
 * Serialises the Hub 4 document model into a real OOXML workbook (design §2.3.5, D-5, D-11). It reads
 * the SAME model the JSON endpoint returns, so the file and the paper cannot disagree.
 *
 * 🔴 Cell typing is the security property (AC-E10): a cell with a `value` becomes a NUMERIC cell with
 * its `numFmt`; every other cell is assigned the JS STRING `text`. ExcelJS writes a formula only for a
 * `{ formula }` object, so `=HYPERLINK(...)` typed into a booking purpose stays inert text.
 *
 * No signature block and no formula totals (DV-7): numbers are numeric, so a clerk can `SUM` them.
 */

const FONT = 'TH Sarabun PSK';
const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFEFEFEF' },
};

const horizontalOf = (a: ReportDocAlign): ExcelJS.Alignment['horizontal'] =>
  a === ReportDocAlign.NUM
    ? 'right'
    : a === ReportDocAlign.CENTER
      ? 'center'
      : 'left';

/** `clamp(ceil(maxDisplayLen * 1.15) + 2, 6, 60)`. */
export const widthOf = (maxDisplayLen: number): number =>
  Math.min(60, Math.max(6, Math.ceil(maxDisplayLen * 1.15) + 2));

function assign(cell: ExcelJS.Cell, c: ReportDocCellDto): void {
  if (c.value !== null) {
    cell.value = c.value;
    if (c.numFmt) cell.numFmt = c.numFmt;
  } else {
    cell.value = c.text;
  }
}

export async function writeReportXlsx(
  doc: Pick<ReportDocumentDto, 'template' | 'header' | 'sections' | 'footer'>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyBook';
  const ws = wb.addWorksheet(SHEET_NAME[doc.template], {
    pageSetup: {
      paperSize: 9,
      orientation:
        doc.template === ReportTemplate.SUMMARY ? 'portrait' : 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });

  const width = Math.max(1, ...doc.sections.map((s) => s.columns.length));
  const maxLen: number[] = Array.from({ length: width }, () => 0);
  const track = (i: number, textValue: string) => {
    maxLen[i] = Math.max(maxLen[i], textValue.length);
  };

  let r = 1;
  const merged = (
    textValue: string,
    bold: boolean,
    size: number,
    align: 'center' | 'left',
  ) => {
    ws.mergeCells(r, 1, r, width);
    const cell = ws.getCell(r, 1);
    cell.value = textValue;
    cell.font = { name: FONT, size, bold };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true };
    r += 1;
  };

  const h = doc.header;
  merged(h.title, true, 18, 'center');
  for (const line of [h.school, h.period, h.kind, h.dateRange, h.scope]) {
    merged(line, false, 16, 'center');
  }
  r += 1; // blank row

  doc.sections.forEach((section, si) => {
    merged(`${si + 1}. ${section.title}`, true, 16, 'left');

    section.columns.forEach((column, ci) => {
      const cell = ws.getCell(r, ci + 1);
      cell.value = column.label;
      cell.font = { name: FONT, size: 16, bold: true };
      cell.fill = HEADER_FILL;
      cell.border = BORDER;
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
      track(ci, column.label);
    });
    r += 1;

    if (section.rows.length === 0) {
      ws.mergeCells(r, 1, r, section.columns.length);
      const cell = ws.getCell(r, 1);
      cell.value = section.emptyText;
      cell.font = { name: FONT, size: 16 };
      cell.border = BORDER;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      r += 1;
    }

    for (const rowModel of section.rows) {
      rowModel.cells.forEach((c, ci) => {
        const cell = ws.getCell(r, ci + 1);
        assign(cell, c);
        cell.font = { name: FONT, size: 16 };
        cell.border = BORDER;
        cell.alignment = {
          horizontal: horizontalOf(section.columns[ci].align),
          vertical: 'top',
          // Free text (a purpose) may be long; wrap it rather than widen the column past 60.
          wrapText: section.columns[ci].align === ReportDocAlign.TEXT,
        };
        track(ci, c.text);
      });
      r += 1;
    }
    r += 1; // blank row after each section
  });

  merged(doc.footer, false, 16, 'left');

  maxLen.forEach((len, i) => {
    ws.getColumn(i + 1).width = widthOf(len);
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
