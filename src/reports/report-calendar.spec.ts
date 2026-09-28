import {
  addDays,
  bangkokDate,
  bangkokMinutesOfDay,
  dayOffset,
  dayStart,
  defaultTrendGrain,
  inclusiveDays,
  isOperatingTime,
  isSchoolDay,
  monthBuckets,
  parseReportDate,
  schoolDaysIn,
  splitAndClip,
  weekBuckets,
} from './report-calendar';

describe('report-calendar (pure, AC-R16 — run under both TZ=UTC and TZ=Asia/Bangkok)', () => {
  describe('bangkokDate / dayStart', () => {
    it('shifts an instant into the Bangkok calendar day (crossing UTC midnight)', () => {
      // 2026-09-02T17:00:00Z = 2026-09-03T00:00:00+07:00
      expect(bangkokDate(new Date('2026-09-02T17:00:00.000Z'))).toBe(
        '2026-09-03',
      );
      expect(bangkokDate(new Date('2026-09-02T16:59:59.999Z'))).toBe(
        '2026-09-02',
      );
    });

    it('AC-R16: 2026-09-01 06:30 +07 (2026-08-31T23:30Z) attributes to 2026-09-01', () => {
      expect(bangkokDate(new Date('2026-08-31T23:30:00.000Z'))).toBe(
        '2026-09-01',
      );
    });

    it('dayStart is the real UTC instant of Bangkok midnight', () => {
      expect(dayStart('2026-09-28').toISOString()).toBe(
        '2026-09-27T17:00:00.000Z',
      );
    });
  });

  describe('parseReportDate', () => {
    it('accepts a real calendar date', () => {
      expect(parseReportDate('2026-05-16')).toBe('2026-05-16');
    });

    it.each([
      ['not a date at all', 'garbage'],
      ['wrong shape', '2026/05/16'],
      ['a full datetime, not a date', '2026-05-16T00:00:00Z'],
      ['a real string, not a real date (Feb 30)', '2026-02-30'],
      ['month 13', '2026-13-01'],
      ['day 0', '2026-05-00'],
    ])('rejects %s (%s)', (_label, input) => {
      expect(parseReportDate(input)).toBeNull();
    });
  });

  describe('addDays / inclusiveDays / dayOffset', () => {
    it('addDays crosses a month and a year boundary', () => {
      expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
      expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    });

    it('inclusiveDays counts both ends, and 366 for a leap-year full year', () => {
      expect(inclusiveDays('2026-05-16', '2026-05-16')).toBe(1);
      expect(inclusiveDays('2026-01-05', '2026-01-11')).toBe(7);
      // 2024 is a leap year — the 366-day cap (D-14) must accept exactly this.
      expect(inclusiveDays('2024-01-01', '2024-12-31')).toBe(366);
      expect(inclusiveDays('2027-01-01', '2027-12-31')).toBe(365);
    });

    it('dayOffset: <0 overdue, 0 today, 1 tomorrow (D-6 badge rule)', () => {
      expect(dayOffset('2026-09-28', '2026-09-27')).toBe(-1);
      expect(dayOffset('2026-09-28', '2026-09-28')).toBe(0);
      expect(dayOffset('2026-09-28', '2026-09-29')).toBe(1);
      expect(dayOffset('2026-09-28', '2026-10-05')).toBe(7);
    });
  });

  describe('isSchoolDay (Mon–Fri, excluding 1 Apr – 15 May)', () => {
    it('a plain weekday is a school day', () => {
      expect(isSchoolDay('2026-01-05')).toBe(true); // Monday
    });

    it('Saturday and Sunday are never school days', () => {
      expect(isSchoolDay('2026-01-03')).toBe(false); // Saturday
      expect(isSchoolDay('2026-01-04')).toBe(false); // Sunday
    });

    it('the summer break overrides an otherwise-schoolday weekday', () => {
      expect(isSchoolDay('2026-03-31')).toBe(true); // Tuesday, just before the break
      expect(isSchoolDay('2026-04-01')).toBe(false); // Wednesday, break start
      expect(isSchoolDay('2026-05-15')).toBe(false); // break end (inclusive)
      expect(isSchoolDay('2026-05-18')).toBe(true); // Monday, just after the break
    });
  });

  describe('schoolDaysIn', () => {
    it('counts Mon–Fri only over a plain week', () => {
      expect(schoolDaysIn('2026-01-05', '2026-01-11')).toBe(5);
    });

    it('excludes summer-break days even when they are weekdays', () => {
      // Mon 2026-03-30 .. Sun 2026-04-05: only Mon 30 + Tue 31 are school days; Apr 1-5 is break.
      expect(schoolDaysIn('2026-03-30', '2026-04-05')).toBe(2);
    });

    it('an inverted range is 0, not negative', () => {
      expect(schoolDaysIn('2026-05-01', '2026-04-01')).toBe(0);
    });
  });

  describe('splitAndClip', () => {
    const h = (ms: number) => ms / 3_600_000;

    it('a Saturday slot contributes 0', () => {
      // 2026-01-03 (Sat) 08:00-12:00 Bangkok = 01:00-05:00Z
      const hours = splitAndClip(
        {
          startAt: new Date('2026-01-03T01:00:00.000Z'),
          endAt: new Date('2026-01-03T05:00:00.000Z'),
        },
        '2026-01-01',
        '2026-01-31',
      );
      expect(hours).toBe(0);
    });

    it('AC-R6: a 07:00–09:30 slot on a school day contributes exactly 1.0 h (clipped at 08:30)', () => {
      // 2026-01-05 (Mon) 07:00-09:30 Bangkok = 00:00-02:30Z
      const hours = splitAndClip(
        {
          startAt: new Date('2026-01-05T00:00:00.000Z'),
          endAt: new Date('2026-01-05T02:30:00.000Z'),
        },
        '2026-01-01',
        '2026-01-31',
      );
      expect(hours).toBeCloseTo(1.0, 10);
    });

    it('a slot crossing 16:30 is clipped there', () => {
      // 2026-01-05 (Mon) 15:00-18:00 Bangkok = 08:00-11:00Z → clipped window is 15:00-16:30 = 1.5h
      const hours = splitAndClip(
        {
          startAt: new Date('2026-01-05T08:00:00.000Z'),
          endAt: new Date('2026-01-05T11:00:00.000Z'),
        },
        '2026-01-01',
        '2026-01-31',
      );
      expect(hours).toBeCloseTo(1.5, 10);
    });

    it('a cross-midnight slot outside the school window on both days contributes 0 (E-6)', () => {
      // 2026-01-05 (Mon) 18:00 -> 2026-01-06 (Tue) 01:00 Bangkok = 2026-01-05T11:00Z -> T18:00Z
      const hours = splitAndClip(
        {
          startAt: new Date('2026-01-05T11:00:00.000Z'),
          endAt: new Date('2026-01-05T18:00:00.000Z'),
        },
        '2026-01-01',
        '2026-01-31',
      );
      expect(hours).toBe(0);
    });

    it('a cross-midnight slot spanning the window on the SECOND day counts only that share (E-6)', () => {
      // 2026-01-05 (Mon) 23:00 -> 2026-01-06 (Tue) 09:00 Bangkok = 16:00Z(05) -> 02:00Z(06)
      // Day 1 (Mon, 23:00-24:00): entirely outside 08:30-16:30 -> 0.
      // Day 2 (Tue, 00:00-09:00): window overlap is 08:30-09:00 = 0.5h.
      const hours = splitAndClip(
        {
          startAt: new Date('2026-01-05T16:00:00.000Z'),
          endAt: new Date('2026-01-06T02:00:00.000Z'),
        },
        '2026-01-01',
        '2026-01-31',
      );
      expect(hours).toBeCloseTo(0.5, 10);
    });

    it('range edges: only the portion inside [fromStr, toStr] counts', () => {
      // A slot spanning two school days; restrict the range to only the second day.
      const slot = {
        // 2026-01-05 09:00 -> 2026-01-06 10:00 Bangkok
        startAt: new Date('2026-01-05T02:00:00.000Z'),
        endAt: new Date('2026-01-06T03:00:00.000Z'),
      };
      const full = splitAndClip(slot, '2026-01-05', '2026-01-06');
      const onlySecondDay = splitAndClip(slot, '2026-01-06', '2026-01-06');
      expect(onlySecondDay).toBeLessThan(full);
      // Day 2 alone: 00:00-10:00 Bangkok clipped to 08:30-10:00 = 1.5h.
      expect(onlySecondDay).toBeCloseTo(1.5, 10);
    });

    it('an inverted range, or endAt <= startAt, is 0', () => {
      const slot = {
        startAt: new Date('2026-01-05T02:00:00.000Z'),
        endAt: new Date('2026-01-05T04:00:00.000Z'),
      };
      expect(splitAndClip(slot, '2026-02-01', '2026-01-01')).toBe(0);
      expect(
        splitAndClip(
          { startAt: slot.endAt, endAt: slot.startAt },
          '2026-01-01',
          '2026-01-31',
        ),
      ).toBe(0);
    });

    it('never returns a negative number of hours', () => {
      const hours = splitAndClip(
        {
          startAt: new Date('2026-01-03T00:00:00.000Z'),
          endAt: new Date('2026-01-03T01:00:00.000Z'),
        },
        '2026-01-01',
        '2026-01-31',
      );
      expect(hours).toBeGreaterThanOrEqual(0);
    });
    void h; // silence unused helper in case a future edit drops its usages
  });

  describe('monthBuckets / weekBuckets', () => {
    it('monthBuckets clips the first and last bucket to the range and flags them partial', () => {
      const buckets = monthBuckets('2026-05-16', '2026-07-10');
      expect(buckets.map((b) => [b.from, b.to, b.partial])).toEqual([
        ['2026-05-16', '2026-05-31', true],
        ['2026-06-01', '2026-06-30', false],
        ['2026-07-01', '2026-07-10', true],
      ]);
    });

    it('weekBuckets starts on Monday and clips the edges', () => {
      // 2026-01-05 is a Monday, so the first bucket needs no clipping on the left.
      const buckets = weekBuckets('2026-01-05', '2026-01-16');
      expect(buckets[0]).toEqual({
        from: '2026-01-05',
        to: '2026-01-11',
        partial: false,
      });
      const last = buckets[buckets.length - 1];
      expect(last.to).toBe('2026-01-16');
      expect(last.partial).toBe(true);
    });

    it('bucket sums equal the whole-range total (AC-R12 shape), for both grains', () => {
      const from = '2026-05-16';
      const to = '2026-10-31';
      const slots = [
        {
          startAt: new Date('2026-06-02T01:00:00.000Z'),
          endAt: new Date('2026-06-02T05:00:00.000Z'),
        },
        {
          startAt: new Date('2026-08-12T02:00:00.000Z'),
          endAt: new Date('2026-08-12T04:00:00.000Z'),
        },
        {
          startAt: new Date('2026-09-28T01:30:00.000Z'),
          endAt: new Date('2026-09-28T04:30:00.000Z'),
        },
        // cross-midnight
        {
          startAt: new Date('2026-10-01T16:00:00.000Z'),
          endAt: new Date('2026-10-02T02:00:00.000Z'),
        },
      ];

      const wholeRangeTotal = slots.reduce(
        (sum, slot) => sum + splitAndClip(slot, from, to),
        0,
      );

      for (const buckets of [monthBuckets(from, to), weekBuckets(from, to)]) {
        const bucketTotal = buckets.reduce(
          (sum, bucket) =>
            sum +
            slots.reduce(
              (s, slot) => s + splitAndClip(slot, bucket.from, bucket.to),
              0,
            ),
          0,
        );
        expect(bucketTotal).toBeCloseTo(wholeRangeTotal, 8);
      }
    });

    it('an inverted range produces no buckets', () => {
      expect(monthBuckets('2026-05-01', '2026-04-01')).toEqual([]);
      expect(weekBuckets('2026-05-01', '2026-04-01')).toEqual([]);
    });
  });

  describe('isOperatingTime (D-3, display bound)', () => {
    it('is true inside Mon–Fri 07:30–16:30 Bangkok', () => {
      // 2026-01-05 (Mon) 08:00 Bangkok = 01:00Z
      expect(isOperatingTime(new Date('2026-01-05T01:00:00.000Z'))).toBe(true);
    });

    it('is false just outside the window, and false on weekends', () => {
      // 07:29 Bangkok
      expect(isOperatingTime(new Date('2026-01-05T00:29:00.000Z'))).toBe(false);
      // 16:31 Bangkok
      expect(isOperatingTime(new Date('2026-01-05T09:31:00.000Z'))).toBe(false);
      // Saturday 10:00 Bangkok
      expect(isOperatingTime(new Date('2026-01-03T03:00:00.000Z'))).toBe(false);
    });
  });

  describe('bangkokMinutesOfDay', () => {
    it('reads minutes since Bangkok local midnight', () => {
      // 08:30 Bangkok = 01:30Z
      expect(bangkokMinutesOfDay(new Date('2026-01-05T01:30:00.000Z'))).toBe(
        8 * 60 + 30,
      );
    });
  });

  describe('defaultTrendGrain', () => {
    it('MONTH above the 45-day threshold, WEEK at or below it', () => {
      expect(defaultTrendGrain(46)).toBe('MONTH');
      expect(defaultTrendGrain(45)).toBe('WEEK');
      expect(defaultTrendGrain(1)).toBe('WEEK');
    });
  });
});
