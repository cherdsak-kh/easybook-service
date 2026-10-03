import { addDays, bangkokMinutesOfDay } from './report-calendar';
import {
  exportCodedError,
  REPORT_PERIOD_MISMATCH_MESSAGE,
} from './report-export.constants';
import { ReportPeriod } from './dto/reports-export-query.dto';

/**
 * Thai Buddhist-era formatting for the official documents (Hub 4, design §2.2). Pure: no `Date` local
 * getters, so the output is identical under `TZ=UTC` and `TZ=Asia/Bangkok`.
 *
 * Typesetting (PO ruling, 2026-10-03): Buddhist-era years in Arabic numerals, dates as `วว ด.ด. ปปปป`
 * with the ABBREVIATED month (`28 ก.ย. 2569`), clock times as `HH.MM น.`.
 */

const MONTH_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

const MONTH_LONG = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

export const THAI_WEEKDAYS_MON_FIRST = [
  'จันทร์',
  'อังคาร',
  'พุธ',
  'พฤหัสบดี',
  'ศุกร์',
  'เสาร์',
  'อาทิตย์',
];

function partsOf(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** `2026-09-28` -> `28 ก.ย. 2569`. */
export function thaiDateShort(iso: string): string {
  const { y, m, d } = partsOf(iso);
  return `${d} ${MONTH_SHORT[m - 1]} ${y + 543}`;
}

/** `2026-09-28` -> `กันยายน พ.ศ. 2569`. */
export function thaiMonthYearLong(iso: string): string {
  const { y, m } = partsOf(iso);
  return `${MONTH_LONG[m - 1]} พ.ศ. ${y + 543}`;
}

/** Bangkok minutes since midnight -> `08.30 น.`. */
export function docClockOfMinutes(minutesOfDay: number): string {
  const h = String(Math.floor(minutesOfDay / 60)).padStart(2, '0');
  const m = String(minutesOfDay % 60).padStart(2, '0');
  return `${h}.${m} น.`;
}

/** The Bangkok clock of an instant, `08.30 น.`. */
export function docClock(at: Date): string {
  return docClockOfMinutes(bangkokMinutesOfDay(at));
}

const groupThousands = (digits: string): string =>
  digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `1234` -> `1,234`. Arabic numerals, en-US grouping, no locale dependence. */
export function docInt(n: number): string {
  const rounded = Math.round(n);
  return `${rounded < 0 ? '-' : ''}${groupThousands(String(Math.abs(rounded)))}`;
}

/**
 * Rounds half away from zero on the value's 15-significant-digit decimal form, which is how a
 * spreadsheet displays a number under a fixed-decimals format. `Number.prototype.toFixed` rounds the
 * binary value instead (`5.55.toFixed(1)` is `5.5`), so using it would let the paper print `5.5` while
 * the `.xlsx` cell shows `5.6`: exactly the disagreement D-5 forbids.
 */
function fixed(n: number, digits: number): string {
  const f = 10 ** digits;
  return (Math.round(Number((n * f).toPrecision(15))) / f).toFixed(digits);
}

/** ALWAYS one decimal (DV-4): `12` -> `12.0`, `1234.56` -> `1,234.6`. */
export function docHours(h: number): string {
  const [int, frac] = fixed(Math.abs(h), 1).split('.');
  return `${h < 0 ? '-' : ''}${groupThousands(int)}.${frac}`;
}

/** `0.457` -> `45.7%` (digits 1) or `46%` (digits 0). */
export function docPercent(fraction: number, digits: 0 | 1): string {
  return `${fixed(fraction * 100, digits)}%`;
}

export interface Term {
  n: 1 | 2;
  /** The Buddhist-era year the term STARTED in. */
  be: number;
}

/**
 * Spec §4.2 as Phase 1 implements it (and the frontend's `report-presets.termOf`): term 1 is
 * 16 May-31 Oct, term 2 is 1 Nov-31 Mar (labelled with the year it started), and 1 Apr-15 May belongs to
 * no term.
 */
export function termOf(iso: string): Term | null {
  const { y, m, d } = partsOf(iso);
  if ((m === 5 && d >= 16) || (m >= 6 && m <= 10)) return { n: 1, be: y + 543 };
  if (m >= 11) return { n: 2, be: y + 543 };
  if (m <= 3) return { n: 2, be: y - 1 + 543 };
  return null;
}

export function termRange(t: Term): { from: string; to: string } {
  const gy = t.be - 543;
  return t.n === 1
    ? { from: `${gy}-05-16`, to: `${gy}-10-31` }
    : { from: `${gy}-11-01`, to: `${gy + 1}-03-31` };
}

const periodMismatch = () =>
  exportCodedError('REPORT_PERIOD_MISMATCH', REPORT_PERIOD_MISMATCH_MESSAGE);

/**
 * D-8. The period line of an official document, derived on the server so paper and `.xlsx` carry the
 * same words. Throws a coded 400 `REPORT_PERIOD_MISMATCH` when TERM/MONTH dates are not that period's
 * exact bounds.
 *
 *  - TERM   -> `ประจำภาคเรียนที่ 1 ปีการศึกษา 2569`
 *  - MONTH  -> `ประจำเดือนกันยายน พ.ศ. 2569`
 *  - CUSTOM -> `ระหว่างวันที่ 1 ก.ย. 2569 ถึงวันที่ 30 ก.ย. 2569`
 */
export function periodLabelOf(
  period: ReportPeriod,
  startDate: string,
  endDate: string,
): string {
  if (period === ReportPeriod.TERM) {
    const term = termOf(startDate);
    const range = term ? termRange(term) : null;
    if (!term || !range || range.from !== startDate || range.to !== endDate) {
      throw periodMismatch();
    }
    return `ประจำภาคเรียนที่ ${term.n} ปีการศึกษา ${term.be}`;
  }
  if (period === ReportPeriod.MONTH) {
    const first = `${startDate.slice(0, 7)}-01`;
    const { y, m } = partsOf(startDate);
    const nextMonthFirst =
      m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const last = addDays(nextMonthFirst, -1);
    if (startDate !== first || endDate !== last) throw periodMismatch();
    return `ประจำเดือน${thaiMonthYearLong(startDate)}`;
  }
  return `ระหว่างวันที่ ${thaiDateShort(startDate)} ถึงวันที่ ${thaiDateShort(endDate)}`;
}
