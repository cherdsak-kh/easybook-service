import {
  docClock,
  docClockOfMinutes,
  docHours,
  docInt,
  docPercent,
  periodLabelOf,
  termOf,
  termRange,
  thaiDateShort,
  thaiMonthYearLong,
} from './report-thai';
import { ReportPeriod } from './dto/reports-export-query.dto';

/**
 * The term fixture table is PASTED VERBATIM into the frontend's `report-presets.test.ts` (design §2.2,
 * R-7): the two repos are independent, so one table in both suites is what keeps the rules from drifting.
 * The `short` column is the PO's `วว ด.ด. ปปปป` form.
 */
const TERM_FIXTURES: Array<{
  input: string;
  term: { n: 1 | 2; be: number } | null;
  range: { from: string; to: string } | null;
  short: string;
  monthYear: string;
}> = [
  {
    input: '2026-05-16',
    term: { n: 1, be: 2569 },
    range: { from: '2026-05-16', to: '2026-10-31' },
    short: '16 พ.ค. 2569',
    monthYear: 'พฤษภาคม พ.ศ. 2569',
  },
  {
    input: '2026-10-31',
    term: { n: 1, be: 2569 },
    range: { from: '2026-05-16', to: '2026-10-31' },
    short: '31 ต.ค. 2569',
    monthYear: 'ตุลาคม พ.ศ. 2569',
  },
  {
    input: '2026-11-01',
    term: { n: 2, be: 2569 },
    range: { from: '2026-11-01', to: '2027-03-31' },
    short: '1 พ.ย. 2569',
    monthYear: 'พฤศจิกายน พ.ศ. 2569',
  },
  {
    input: '2027-03-31',
    term: { n: 2, be: 2569 },
    range: { from: '2026-11-01', to: '2027-03-31' },
    short: '31 มี.ค. 2570',
    monthYear: 'มีนาคม พ.ศ. 2570',
  },
  {
    input: '2027-04-01',
    term: null,
    range: null,
    short: '1 เม.ย. 2570',
    monthYear: 'เมษายน พ.ศ. 2570',
  },
  {
    input: '2027-05-15',
    term: null,
    range: null,
    short: '15 พ.ค. 2570',
    monthYear: 'พฤษภาคม พ.ศ. 2570',
  },
  {
    input: '2028-02-29',
    term: { n: 2, be: 2570 },
    range: { from: '2027-11-01', to: '2028-03-31' },
    short: '29 ก.พ. 2571',
    monthYear: 'กุมภาพันธ์ พ.ศ. 2571',
  },
];

describe('report-thai', () => {
  describe.each(TERM_FIXTURES)('$input', (f) => {
    it('termOf', () => expect(termOf(f.input)).toEqual(f.term));
    it('termRange', () => {
      if (f.term) expect(termRange(f.term)).toEqual(f.range);
    });
    it('thaiDateShort is วว ด.ด. ปปปป', () =>
      expect(thaiDateShort(f.input)).toBe(f.short));
    it('thaiMonthYearLong', () =>
      expect(thaiMonthYearLong(f.input)).toBe(f.monthYear));
  });

  describe('number formatting', () => {
    it('docInt groups with commas and uses Arabic numerals', () => {
      expect(docInt(0)).toBe('0');
      expect(docInt(1234)).toBe('1,234');
      expect(docInt(1234567)).toBe('1,234,567');
      expect(docInt(999.6)).toBe('1,000');
    });

    it('docHours ALWAYS has one decimal (DV-4)', () => {
      expect(docHours(12)).toBe('12.0');
      expect(docHours(0)).toBe('0.0');
      expect(docHours(1234.56)).toBe('1,234.6');
      expect(docHours(0.04)).toBe('0.0');
    });

    it('rounds half away from zero like a spreadsheet, so paper and .xlsx agree (5.55 is 5.6, not 5.5)', () => {
      expect(docHours(5.55)).toBe('5.6');
      expect(docHours(0.05)).toBe('0.1');
      expect(docHours(2.25)).toBe('2.3');
      expect(docPercent(0.4575, 1)).toBe('45.8%');
      expect(docPercent(0.125, 0)).toBe('13%');
    });

    it('docPercent takes a fraction', () => {
      expect(docPercent(0.457, 1)).toBe('45.7%');
      expect(docPercent(0.4567, 0)).toBe('46%');
      expect(docPercent(0, 1)).toBe('0.0%');
      expect(docPercent(1, 0)).toBe('100%');
    });
  });

  describe('clock times are HH.MM น. on the Bangkok clock', () => {
    it('docClockOfMinutes', () => {
      expect(docClockOfMinutes(8 * 60 + 30)).toBe('08.30 น.');
      expect(docClockOfMinutes(0)).toBe('00.00 น.');
      expect(docClockOfMinutes(16 * 60 + 30)).toBe('16.30 น.');
    });

    it.each([
      ['2026-09-28T01:30:00Z', '08.30 น.'],
      ['2026-09-28T17:00:00Z', '00.00 น.'], // 00:00 +07 the next day
      ['2026-09-28T16:59:00Z', '23.59 น.'],
    ])(
      'docClock(%s) = %s regardless of the process time zone',
      (iso, expected) => {
        expect(docClock(new Date(iso))).toBe(expected);
      },
    );
  });

  describe('periodLabelOf (D-8)', () => {
    it('TERM: the exact bounds give the term label', () => {
      expect(periodLabelOf(ReportPeriod.TERM, '2026-05-16', '2026-10-31')).toBe(
        'ประจำภาคเรียนที่ 1 ปีการศึกษา 2569',
      );
      expect(periodLabelOf(ReportPeriod.TERM, '2027-11-01', '2028-03-31')).toBe(
        'ประจำภาคเรียนที่ 2 ปีการศึกษา 2570',
      );
    });

    it.each([
      ['a day short', '2026-05-16', '2026-10-30'],
      ['a late start', '2026-05-17', '2026-10-31'],
      ['the summer break', '2027-04-01', '2027-05-15'],
      ['a span over two terms', '2026-05-16', '2027-03-31'],
    ])('TERM with %s is a coded REPORT_PERIOD_MISMATCH', (_l, s, e) => {
      expect(() => periodLabelOf(ReportPeriod.TERM, s, e)).toThrow();
      try {
        periodLabelOf(ReportPeriod.TERM, s, e);
      } catch (err) {
        expect(
          (err as { response: { code: string; statusCode: number } }).response,
        ).toMatchObject({
          statusCode: 400,
          code: 'REPORT_PERIOD_MISMATCH',
        });
      }
    });

    it('MONTH: the first to the last day of ONE month, leap February included', () => {
      expect(
        periodLabelOf(ReportPeriod.MONTH, '2026-09-01', '2026-09-30'),
      ).toBe('ประจำเดือนกันยายน พ.ศ. 2569');
      expect(
        periodLabelOf(ReportPeriod.MONTH, '2028-02-01', '2028-02-29'),
      ).toBe('ประจำเดือนกุมภาพันธ์ พ.ศ. 2571');
      expect(
        periodLabelOf(ReportPeriod.MONTH, '2026-12-01', '2026-12-31'),
      ).toBe('ประจำเดือนธันวาคม พ.ศ. 2569');
    });

    it.each([
      ['a short month', '2026-09-01', '2026-09-29'],
      ['a mid-month start', '2026-09-02', '2026-09-30'],
      ['two months', '2026-09-01', '2026-10-31'],
      ['Feb 28 in a leap year', '2028-02-01', '2028-02-28'],
    ])('MONTH with %s is REPORT_PERIOD_MISMATCH', (_l, s, e) => {
      expect(() => periodLabelOf(ReportPeriod.MONTH, s, e)).toThrow();
    });

    it('CUSTOM: any range, in the short date form', () => {
      expect(
        periodLabelOf(ReportPeriod.CUSTOM, '2026-09-01', '2026-09-30'),
      ).toBe('ระหว่างวันที่ 1 ก.ย. 2569 ถึงวันที่ 30 ก.ย. 2569');
    });
  });
});
