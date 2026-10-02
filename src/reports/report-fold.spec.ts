import { BookingStatus } from '@prisma/client';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import {
  foldHeldMs,
  isAutoRejected,
  isOpen,
  lateCancelledSlots,
  occupancyOf,
  parseReportRange,
  reportWindowAt,
  type OpenReportWindow,
} from './report-fold';

describe('report-fold (design §2.1.2, checklist item 2)', () => {
  describe('parseReportRange', () => {
    it('accepts a real, non-inverted, within-cap range', () => {
      expect(parseReportRange('2026-01-05', '2026-01-11')).toEqual({
        startDate: '2026-01-05',
        endDate: '2026-01-11',
        days: 7,
      });
    });

    it('rejects a malformed date -> REPORT_DATE_INVALID', () => {
      expect(() => parseReportRange('2026-02-30', '2026-03-01')).toThrow();
      try {
        parseReportRange('2026-02-30', '2026-03-01');
      } catch (e) {
        expect(
          (e as { getResponse: () => { code: string } }).getResponse(),
        ).toMatchObject({ code: 'REPORT_DATE_INVALID' });
      }
    });

    it('rejects an inverted range -> REPORT_RANGE_INVERTED', () => {
      try {
        parseReportRange('2026-02-01', '2026-01-01');
        fail('expected throw');
      } catch (e) {
        expect(
          (e as { getResponse: () => { code: string } }).getResponse(),
        ).toMatchObject({ code: 'REPORT_RANGE_INVERTED' });
      }
    });

    it('rejects a range over 366 days -> REPORT_RANGE_TOO_WIDE', () => {
      try {
        parseReportRange('2019-01-01', '2020-01-02');
        fail('expected throw');
      } catch (e) {
        expect(
          (e as { getResponse: () => { code: string } }).getResponse(),
        ).toMatchObject({ code: 'REPORT_RANGE_TOO_WIDE' });
      }
    });
  });

  describe('reportWindowAt / isOpen', () => {
    it('a range entirely in the future is closed (E-13)', () => {
      const range = parseReportRange('2030-01-01', '2030-01-02');
      const w = reportWindowAt(range, new Date('2026-01-01T00:00:00.000Z'));
      expect(isOpen(w)).toBe(false);
      expect(w.effectiveEndDate).toBeNull();
      expect(w.schoolDays).toBe(0);
    });

    it('a past range is open, with S/E as Bangkok-midnight instants', () => {
      const range = parseReportRange('2020-01-06', '2020-01-12');
      const w = reportWindowAt(range, new Date('2026-01-01T00:00:00.000Z'));
      expect(isOpen(w)).toBe(true);
      if (isOpen(w)) {
        expect(w.effectiveEndDate).toBe('2020-01-12');
        expect(w.schoolDays).toBe(5);
        expect(w.S.toISOString()).toBe('2020-01-05T17:00:00.000Z');
        expect(w.E.toISOString()).toBe('2020-01-12T17:00:00.000Z');
      }
    });
  });

  describe('foldHeldMs — order independence (design §2.1.2)', () => {
    it('totalMs is identical regardless of row order', () => {
      const range = parseReportRange('2026-01-01', '2026-01-31');
      const w = reportWindowAt(
        range,
        new Date('2026-02-15T00:00:00.000Z'),
      ) as OpenReportWindow;
      const slots = [
        {
          venueId: 'v1',
          startAt: new Date('2026-01-05T02:00:00.000Z'), // Mon 09:00 Bangkok
          endAt: new Date('2026-01-05T02:20:00.000Z'), // 20 minutes
        },
        {
          venueId: 'v1',
          startAt: new Date('2026-01-06T03:00:00.000Z'), // Tue 10:00 Bangkok
          endAt: new Date('2026-01-06T03:40:00.000Z'), // 40 minutes
        },
        {
          venueId: 'v2',
          startAt: new Date('2026-01-07T05:00:00.000Z'), // Wed 12:00 Bangkok
          endAt: new Date('2026-01-07T06:10:00.000Z'), // 70 minutes
        },
      ];
      const forward = foldHeldMs(slots, w);
      const shuffled = foldHeldMs([...slots].reverse(), w);
      expect(shuffled.totalMs).toBe(forward.totalMs);
      expect(shuffled.msByVenue.get('v1')).toBe(forward.msByVenue.get('v1'));
      expect(shuffled.msByVenue.get('v2')).toBe(forward.msByVenue.get('v2'));
    });
  });

  describe('occupancyOf', () => {
    it('is null when the denominator is 0', () => {
      expect(occupancyOf(0, 0, 5).occupancyPercent).toBeNull();
      expect(occupancyOf(0, 5, 0).occupancyPercent).toBeNull();
    });

    it('computes the standard denominator', () => {
      const o = occupancyOf(4, 5, 2); // 4h / (5*8*2=80h) = 5%
      expect(o.occupancyPercent).toBeCloseTo(5, 10);
    });
  });

  describe('lateCancelledSlots', () => {
    const start = new Date('2026-01-05T03:00:00.000Z'); // 10:00 Bangkok
    const lead = 30 * 60_000;

    it('exactly at the lead boundary is NOT late (design: cancelledAt > startAt - lead)', () => {
      const cancelledAt = new Date(start.getTime() - lead);
      expect(
        lateCancelledSlots([{ startAt: start, cancelledAt }], lead),
      ).toEqual([]);
    });

    it('1ms inside the lead boundary IS late', () => {
      const cancelledAt = new Date(start.getTime() - lead + 1);
      expect(
        lateCancelledSlots([{ startAt: start, cancelledAt }], lead).length,
      ).toBe(1);
    });

    it('cancelled after start is late', () => {
      const cancelledAt = new Date(start.getTime() + 60_000);
      expect(
        lateCancelledSlots([{ startAt: start, cancelledAt }], lead).length,
      ).toBe(1);
    });

    it('cancelledAt null is never late', () => {
      expect(
        lateCancelledSlots([{ startAt: start, cancelledAt: null }], lead),
      ).toEqual([]);
    });
  });

  describe('isAutoRejected (imported constant, R-1/R-2)', () => {
    it('a REJECTED row with the auto-reject reason is flagged', () => {
      expect(
        isAutoRejected({
          status: BookingStatus.REJECTED,
          rejectReason: AUTO_REJECTED_REASON,
        }),
      ).toBe(true);
      expect(
        isAutoRejected({
          status: BookingStatus.REJECTED,
          rejectReason: 'other',
        }),
      ).toBe(false);
      expect(
        isAutoRejected({
          status: BookingStatus.APPROVED,
          rejectReason: null,
        }),
      ).toBe(false);
    });
  });
});
