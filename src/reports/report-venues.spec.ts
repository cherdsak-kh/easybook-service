import { BookingStatus } from '@prisma/client';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import { foldHeldMs, parseReportRange, reportWindowAt } from './report-fold';
import type { OpenReportWindow } from './report-fold';
import {
  buildVenueRows,
  foldHeatmap,
  toCellDtos,
  topClashOf,
} from './report-venues';

const NOW = new Date('2026-02-15T00:00:00.000Z');

function windowOf(start: string, end: string): OpenReportWindow {
  const range = parseReportRange(start, end);
  const w = reportWindowAt(range, NOW);
  if (!('S' in w)) throw new Error('expected an open window');
  return w;
}

describe('report-venues (design §2.2, checklist item 5, AC-V9)', () => {
  const w = windowOf('2026-01-01', '2026-01-31');

  describe('foldHeatmap', () => {
    it('a Mon 09:00-10:00 slot adds 0.5h + 1 segment to cells 0 and 1', () => {
      const slots = [
        {
          venueId: 'v1',
          startAt: new Date('2026-01-05T02:00:00.000Z'), // Mon 09:00 Bangkok
          endAt: new Date('2026-01-05T03:00:00.000Z'), // Mon 10:00 Bangkok
        },
      ];
      const { all } = foldHeatmap(slots, w);
      const dtos = toCellDtos(all);
      expect(dtos[0]).toEqual({ heldHours: 0.5, segments: 1 }); // cell 0 = 08:30-09:30
      expect(dtos[1]).toEqual({ heldHours: 0.5, segments: 1 }); // cell 1 = 09:30-10:30
      for (let i = 2; i < 40; i += 1) {
        expect(dtos[i]).toEqual({ heldHours: 0, segments: 0 });
      }
    });

    it('a 07:00-09:00 slot adds 0.5h to cell 0 only', () => {
      const slots = [
        {
          venueId: 'v1',
          startAt: new Date('2026-01-05T00:00:00.000Z'), // Mon 07:00 Bangkok
          endAt: new Date('2026-01-05T02:00:00.000Z'), // Mon 09:00 Bangkok
        },
      ];
      const dtos = toCellDtos(foldHeatmap(slots, w).all);
      expect(dtos[0]).toEqual({ heldHours: 0.5, segments: 1 });
      expect(dtos[1]).toEqual({ heldHours: 0, segments: 0 });
    });

    it('a Saturday slot adds nothing', () => {
      const slots = [
        {
          venueId: 'v1',
          startAt: new Date('2026-01-03T01:00:00.000Z'),
          endAt: new Date('2026-01-03T05:00:00.000Z'),
        },
      ];
      const { all } = foldHeatmap(slots, w);
      expect(all.every((c) => c.ms === 0 && c.segments === 0)).toBe(true);
    });

    it('a cross-midnight slot contributes only its in-window parts, per Bangkok day', () => {
      const slots = [
        {
          venueId: 'v1',
          // Mon 23:00 -> Tue 09:00 Bangkok
          startAt: new Date('2026-01-05T16:00:00.000Z'),
          endAt: new Date('2026-01-06T02:00:00.000Z'),
        },
      ];
      const dtos = toCellDtos(foldHeatmap(slots, w).all);
      // Tue cell 0 (index 8) = 08:30-09:00 = 0.5h; nothing else.
      expect(dtos[8]).toEqual({ heldHours: 0.5, segments: 1 });
      const total = dtos.reduce((s, c) => s + c.heldHours, 0);
      expect(total).toBeCloseTo(0.5, 10);
    });

    it('Σ 40 cellMs (scope all) equals foldHeldMs totalMs on a mixed fixture', () => {
      const slots = [
        {
          venueId: 'v1',
          startAt: new Date('2026-01-05T02:00:00.000Z'),
          endAt: new Date('2026-01-05T03:00:00.000Z'),
        },
        {
          venueId: 'v1',
          startAt: new Date('2026-01-06T00:00:00.000Z'),
          endAt: new Date('2026-01-06T02:00:00.000Z'),
        },
        {
          venueId: 'v2',
          startAt: new Date('2026-01-08T05:00:00.000Z'),
          endAt: new Date('2026-01-08T06:10:00.000Z'),
        },
        {
          venueId: 'v1',
          startAt: new Date('2026-01-03T01:00:00.000Z'),
          endAt: new Date('2026-01-03T05:00:00.000Z'),
        }, // Saturday, contributes 0
      ];
      const { all } = foldHeatmap(slots, w);
      const cellTotal = all.reduce((s, c) => s + c.ms, 0);
      const { totalMs } = foldHeldMs(slots, w);
      expect(cellTotal).toBe(totalMs);
    });
  });

  describe('topClashOf', () => {
    const autoRejectedRow = (
      weekdayDate: string,
      hh: number,
      mm: number,
      endHH: number,
      endMM: number,
    ) => ({
      status: BookingStatus.REJECTED,
      rejectReason: AUTO_REJECTED_REASON,
      slots: [
        {
          startAt: new Date(
            `${weekdayDate}T${String(hh - 7).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`,
          ),
          endAt: new Date(
            `${weekdayDate}T${String(endHH - 7).padStart(2, '0')}:${String(endMM).padStart(2, '0')}:00.000Z`,
          ),
        },
      ],
    });

    it('null when there are no auto-rejects', () => {
      expect(topClashOf([])).toBeNull();
      expect(
        topClashOf([
          { status: BookingStatus.APPROVED, rejectReason: null, slots: [] },
        ]),
      ).toBeNull();
    });

    it('picks the highest count; ties broken by lower weekday, earlier start, earlier end', () => {
      const rows = [
        autoRejectedRow('2026-01-05', 13, 0, 15, 0), // Mon 13:00-15:00, x2
        autoRejectedRow('2026-01-05', 13, 0, 15, 0),
        autoRejectedRow('2026-01-06', 9, 0, 11, 0), // Tue 09:00-11:00, x1
      ];
      const top = topClashOf(rows);
      expect(top).toEqual({
        isoWeekday: 1,
        startTime: '13:00',
        endTime: '15:00',
        count: 2,
      });
    });

    it('ties on count: lower weekday wins', () => {
      const rows = [
        autoRejectedRow('2026-01-06', 9, 0, 11, 0), // Tue
        autoRejectedRow('2026-01-05', 13, 0, 15, 0), // Mon
      ];
      const top = topClashOf(rows);
      expect(top?.isoWeekday).toBe(1);
    });
  });

  describe('buildVenueRows', () => {
    const venueRows = [
      {
        id: 'v1',
        name: 'หอประชุม',
        capacity: 100,
        isOpen: true,
        deletedAt: null,
        venueType: { name: 'หอประชุม' },
      },
      {
        id: 'v2',
        name: 'ห้องเก่า',
        capacity: 20,
        isOpen: false,
        deletedAt: new Date(),
        venueType: { name: 'ห้องประชุม' },
      },
      {
        id: 'v3',
        name: 'ห้องว่าง',
        capacity: 30,
        isOpen: true,
        deletedAt: null,
        venueType: { name: 'ห้องประชุม' },
      },
    ];

    it('keeps a deleted venue only when it has activity', () => {
      const rows = buildVenueRows(
        venueRows,
        [],
        { msByVenue: new Map() },
        { byVenue: new Map() },
        5,
      );
      const ids = rows.map((r) => r.venueId);
      expect(ids).toContain('v1');
      expect(ids).toContain('v3');
      expect(ids).not.toContain('v2'); // deleted, no activity
    });

    it('sorts by occupancy desc, then requests desc, then name', () => {
      const rows = buildVenueRows(
        venueRows,
        [
          {
            venueId: 'v3',
            status: BookingStatus.APPROVED,
            rejectReason: null,
            slots: [],
          },
          {
            venueId: 'v3',
            status: BookingStatus.PENDING,
            rejectReason: null,
            slots: [],
          },
        ],
        { msByVenue: new Map([['v1', 5 * 3_600_000]]) },
        { byVenue: new Map() },
        5,
      );
      // v1 has heldHours (occupancy > 0); v3 has requests but no held hours.
      expect(rows[0].venueId).toBe('v1');
      expect(rows.find((r) => r.venueId === 'v3')?.requests).toBe(2);
    });
  });
});
