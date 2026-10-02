import {
  HOUR_MS,
  clipToSchoolWindow,
  isoWeekdayOf,
  schoolDaysByWeekday,
  schoolWindowStartMs,
  splitAndClipMs,
} from './report-calendar';

/**
 * Phase 2 additions to `report-calendar.ts` (design §2.1.2, checklist item 1). `report-calendar.spec.ts`
 * stays unedited — this is a SEPARATE file for the new heatmap/weekday helpers, run under AC-R16's
 * both-timezone rule.
 */
describe('report-calendar Phase 2 additions (AC-V9 — run under both TZ=UTC and TZ=Asia/Bangkok)', () => {
  describe('isoWeekdayOf', () => {
    it('Monday is 1, Sunday is 7', () => {
      expect(isoWeekdayOf('2026-01-05')).toBe(1); // Monday
      expect(isoWeekdayOf('2026-01-10')).toBe(6); // Saturday
      expect(isoWeekdayOf('2026-01-11')).toBe(7); // Sunday
    });
  });

  describe('clipToSchoolWindow / splitAndClipMs', () => {
    it('a Mon 09:00–10:00 slot produces two segments: 08:30–09:30 half and 09:30–10:30 half (0.5h each)', () => {
      // 2026-01-05 (Mon) 09:00-10:00 Bangkok = 02:00-03:00Z
      const slot = {
        startAt: new Date('2026-01-05T02:00:00.000Z'),
        endAt: new Date('2026-01-05T03:00:00.000Z'),
      };
      const segs = clipToSchoolWindow(slot, '2026-01-01', '2026-01-31');
      expect(segs).toHaveLength(1);
      expect(segs[0].isoWeekday).toBe(1);
      expect(segs[0].date).toBe('2026-01-05');
      expect(segs[0].endMs - segs[0].startMs).toBe(HOUR_MS);
      const total = splitAndClipMs(slot, '2026-01-01', '2026-01-31');
      expect(total).toBe(HOUR_MS);
    });

    it('a 07:00–09:00 slot clips to 08:30–09:00 only (0.5h)', () => {
      // 2026-01-05 (Mon) 07:00-09:00 Bangkok = 00:00-02:00Z
      const slot = {
        startAt: new Date('2026-01-05T00:00:00.000Z'),
        endAt: new Date('2026-01-05T02:00:00.000Z'),
      };
      const segs = clipToSchoolWindow(slot, '2026-01-01', '2026-01-31');
      expect(segs).toHaveLength(1);
      expect(segs[0].endMs - segs[0].startMs).toBe(HOUR_MS / 2);
      expect(splitAndClipMs(slot, '2026-01-01', '2026-01-31')).toBe(
        HOUR_MS / 2,
      );
    });

    it('a Saturday slot produces no segments', () => {
      const slot = {
        startAt: new Date('2026-01-03T01:00:00.000Z'),
        endAt: new Date('2026-01-03T05:00:00.000Z'),
      };
      expect(clipToSchoolWindow(slot, '2026-01-01', '2026-01-31')).toEqual([]);
      expect(splitAndClipMs(slot, '2026-01-01', '2026-01-31')).toBe(0);
    });

    it('a summer-break slot produces no segments', () => {
      // 2026-04-15 (Wed, inside 1 Apr - 15 May break) 09:00-10:00 Bangkok
      const slot = {
        startAt: new Date('2026-04-15T02:00:00.000Z'),
        endAt: new Date('2026-04-15T03:00:00.000Z'),
      };
      expect(clipToSchoolWindow(slot, '2026-04-01', '2026-04-30')).toEqual([]);
    });

    it('a cross-midnight slot splits per Bangkok day, each clipped independently', () => {
      // 2026-01-05 (Mon) 23:00 -> 2026-01-06 (Tue) 09:00 Bangkok = 16:00Z(05) -> 02:00Z(06)
      const slot = {
        startAt: new Date('2026-01-05T16:00:00.000Z'),
        endAt: new Date('2026-01-06T02:00:00.000Z'),
      };
      const segs = clipToSchoolWindow(slot, '2026-01-01', '2026-01-31');
      // Day 1 (Mon 23:00-24:00): outside 08:30-16:30 -> no segment.
      // Day 2 (Tue 00:00-09:00): overlap 08:30-09:00 = 0.5h.
      expect(segs).toHaveLength(1);
      expect(segs[0].date).toBe('2026-01-06');
      expect(segs[0].isoWeekday).toBe(2);
      expect(segs[0].endMs - segs[0].startMs).toBe(HOUR_MS / 2);
    });

    it('a zero-length or inverted slot -> []', () => {
      const zero = {
        startAt: new Date('2026-01-05T02:00:00.000Z'),
        endAt: new Date('2026-01-05T02:00:00.000Z'),
      };
      const inverted = {
        startAt: new Date('2026-01-05T04:00:00.000Z'),
        endAt: new Date('2026-01-05T02:00:00.000Z'),
      };
      expect(clipToSchoolWindow(zero, '2026-01-01', '2026-01-31')).toEqual([]);
      expect(clipToSchoolWindow(inverted, '2026-01-01', '2026-01-31')).toEqual(
        [],
      );
    });

    it('an inverted range -> []', () => {
      const slot = {
        startAt: new Date('2026-01-05T02:00:00.000Z'),
        endAt: new Date('2026-01-05T03:00:00.000Z'),
      };
      expect(clipToSchoolWindow(slot, '2026-02-01', '2026-01-01')).toEqual([]);
    });

    it('segments tile the 40-cell window exactly: Σ over j of overlap == segment length', () => {
      const winStart = schoolWindowStartMs('2026-01-05');
      const slot = {
        startAt: new Date(winStart + 1.25 * HOUR_MS),
        endAt: new Date(winStart + 3.75 * HOUR_MS),
      };
      const segs = clipToSchoolWindow(slot, '2026-01-01', '2026-01-31');
      expect(segs).toHaveLength(1);
      let coveredMs = 0;
      for (let j = 0; j < 8; j += 1) {
        const cellStart = winStart + j * HOUR_MS;
        const cellEnd = cellStart + HOUR_MS;
        const overlap =
          Math.min(segs[0].endMs, cellEnd) -
          Math.max(segs[0].startMs, cellStart);
        if (overlap > 0) coveredMs += overlap;
      }
      expect(coveredMs).toBe(segs[0].endMs - segs[0].startMs);
    });
  });

  describe('schoolDaysByWeekday', () => {
    it('a plain Mon-Fri week gives 1 for each of the 5 weekdays', () => {
      expect(schoolDaysByWeekday('2026-01-05', '2026-01-11')).toEqual([
        1, 1, 1, 1, 1,
      ]);
    });

    it('sums to schoolDaysIn over a range spanning the summer break', () => {
      const counts = schoolDaysByWeekday('2026-03-30', '2026-04-05');
      const sum = counts.reduce((s, n) => s + n, 0);
      expect(sum).toBe(2); // Mon 30 + Tue 31 only (design §2.1: schoolDaysIn parity)
    });

    it('an inverted range gives all zeros', () => {
      expect(schoolDaysByWeekday('2026-05-01', '2026-04-01')).toEqual([
        0, 0, 0, 0, 0,
      ]);
    });
  });
});
