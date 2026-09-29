import {
  computeRoomStates,
  type RoomSlotInput,
  type RoomVenueInput,
} from './dashboard-rooms';

/** A slot factory keeping the boilerplate fields out of every test. */
const slot = (
  over: Partial<RoomSlotInput> &
    Pick<RoomSlotInput, 'venueId' | 'startAt' | 'endAt'>,
): RoomSlotInput => ({
  slotId: `slot-${Math.random()}`,
  bookingRequestId: `req-${Math.random()}`,
  code: 'BR-25690928-001',
  purpose: 'ประชุม',
  attendees: 10,
  requesterName: 'สมชาย ใจดี',
  departmentName: 'ฝ่ายวิชาการ',
  ...over,
});

const venue = (
  over: Partial<RoomVenueInput> & Pick<RoomVenueInput, 'id'>,
): RoomVenueInput => ({
  name: over.id,
  capacity: 100,
  isOpen: true,
  closedReason: null,
  ...over,
});

// 2026-01-05 (Monday) — a plain school day, used throughout so BANGKOK offsets are unambiguous.
const bkk = (hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 0, 5, hh, mm) - 7 * 3_600_000);

describe('computeRoomStates', () => {
  it('zero bookings: every open venue is FREE, ALL_DAY headline before noon, no crash on empty input', () => {
    const now = bkk(9, 0);
    const result = computeRoomStates(
      [venue({ id: 'v1' }), venue({ id: 'v2' })],
      [],
      now,
    );
    expect(result.counts).toEqual({ all: 2, busy: 0, free: 2, off: 0 });
    expect(result.todayBookings).toBe(0);
    expect(result.inUseNow).toBe(0);
    for (const room of result.venues) {
      expect(room.state).toBe('FREE');
      expect(room.freeWindow).toBe('ALL_DAY');
      expect(room.freeUntil).toBeNull();
      expect(room.next).toBeNull();
    }
  });

  it('no venues at all: empty counts, no crash, no division by zero', () => {
    const result = computeRoomStates([], [], bkk(10));
    expect(result.counts).toEqual({ all: 0, busy: 0, free: 0, off: 0 });
    expect(result.todayBookings).toBe(0);
    expect(result.venues).toEqual([]);
  });

  it('back-to-back slots: half-open — at 12:00 the second slot is current, never a 1-minute free flash (E-7)', () => {
    const v = venue({ id: 'v1' });
    const first = slot({ venueId: 'v1', startAt: bkk(10), endAt: bkk(12) });
    const second = slot({ venueId: 'v1', startAt: bkk(12), endAt: bkk(14) });

    const atNoon = computeRoomStates([v], [first, second], bkk(12, 0));
    expect(atNoon.venues[0].state).toBe('BUSY');
    expect(atNoon.venues[0].current?.bookingRequestId).toBe(
      second.bookingRequestId,
    );

    const justBefore = computeRoomStates([v], [first, second], bkk(11, 59));
    expect(justBefore.venues[0].current?.bookingRequestId).toBe(
      first.bookingRequestId,
    );

    // A slot ending exactly now is not current (endAt is exclusive).
    const exactlyAtFirstEnd = computeRoomStates([v], [first], bkk(12, 0));
    expect(exactlyAtFirstEnd.venues[0].state).toBe('FREE');
  });

  it('off-hours headlines follow D-3: ALL_DAY < 12:00, AFTERNOON 12:00-16:30, REST_OF_DAY after 16:30', () => {
    const v = venue({ id: 'v1' });
    expect(computeRoomStates([v], [], bkk(11, 59)).venues[0].freeWindow).toBe(
      'ALL_DAY',
    );
    expect(computeRoomStates([v], [], bkk(12, 0)).venues[0].freeWindow).toBe(
      'AFTERNOON',
    );
    expect(computeRoomStates([v], [], bkk(16, 30)).venues[0].freeWindow).toBe(
      'AFTERNOON',
    );
    expect(computeRoomStates([v], [], bkk(16, 31)).venues[0].freeWindow).toBe(
      'REST_OF_DAY',
    );
    expect(computeRoomStates([v], [], bkk(20, 0)).venues[0].freeWindow).toBe(
      'REST_OF_DAY',
    );
  });

  it('a FREE venue with a later slot today reports UNTIL_NEXT and freeUntil = the next slot start', () => {
    const v = venue({ id: 'v1' });
    const upcoming = slot({ venueId: 'v1', startAt: bkk(15), endAt: bkk(16) });
    const result = computeRoomStates([v], [upcoming], bkk(9));
    const room = result.venues[0];
    expect(room.state).toBe('FREE');
    expect(room.freeWindow).toBe('UNTIL_NEXT');
    expect(room.freeUntil).toEqual(upcoming.startAt);
    expect(room.next?.purpose).toBe(upcoming.purpose);
  });

  it('multi-slot request: a room is BUSY only for the slot covering now (E-5)', () => {
    const v = venue({ id: 'v1' });
    const requestId = 'req-multi';
    const monday = slot({
      venueId: 'v1',
      bookingRequestId: requestId,
      startAt: bkk(9),
      endAt: bkk(10),
    });
    const later = slot({
      venueId: 'v1',
      bookingRequestId: requestId,
      startAt: bkk(13),
      endAt: bkk(14),
    });
    const atNine30 = computeRoomStates([v], [monday, later], bkk(9, 30));
    expect(atNine30.venues[0].state).toBe('BUSY');
    expect(atNine30.venues[0].current?.slotId).toBe(monday.slotId);
    expect(atNine30.venues[0].todaySlotCount).toBe(2);

    const atNoon = computeRoomStates([v], [monday, later], bkk(12));
    expect(atNoon.venues[0].state).toBe('FREE');
    expect(atNoon.venues[0].next?.startAt).toEqual(later.startAt);
  });

  it('OQ-3: a closed venue is OFF even with an approved slot covering now', () => {
    const closed = venue({
      id: 'v1',
      isOpen: false,
      closedReason: 'ปิดปรับปรุงพื้นสนาม',
    });
    const coveringNow = slot({
      venueId: 'v1',
      startAt: bkk(9),
      endAt: bkk(11),
    });
    const result = computeRoomStates([closed], [coveringNow], bkk(10));
    const room = result.venues[0];
    expect(room.state).toBe('OFF');
    expect(room.closedReason).toBe('ปิดปรับปรุงพื้นสนาม');
    expect(room.current).toBeNull();
    // OFF venues still report todaySlotCount (AC-D11), but are excluded from card 3 / inUseNow.
    expect(room.todaySlotCount).toBe(1);
    expect(result.todayBookings).toBe(0);
    expect(result.inUseNow).toBe(0);
    expect(result.counts).toEqual({ all: 1, busy: 0, free: 0, off: 1 });
  });

  it('a closed venue with no closedReason falls back to the documented copy', () => {
    const closed = venue({ id: 'v1', isOpen: false, closedReason: null });
    const result = computeRoomStates([closed], [], bkk(10));
    expect(result.venues[0].closedReason).toBe(
      'สถานที่นี้ปิดรับการจองชั่วคราว',
    );
  });

  it('sort order is BUSY -> FREE -> OFF, then the input order', () => {
    const free = venue({ id: 'v-free' });
    const off = venue({ id: 'v-off', isOpen: false, closedReason: 'x' });
    const busy = venue({ id: 'v-busy' });
    const busySlot = slot({
      venueId: 'v-busy',
      startAt: bkk(9),
      endAt: bkk(11),
    });
    const result = computeRoomStates([free, off, busy], [busySlot], bkk(10));
    expect(result.venues.map((v) => v.id)).toEqual([
      'v-busy',
      'v-free',
      'v-off',
    ]);
  });

  it('progress and remaining minutes are computed at the given instant, clamped and >= 1', () => {
    const v = venue({ id: 'v1' });
    const s = slot({ venueId: 'v1', startAt: bkk(10), endAt: bkk(14) }); // 4h slot
    const oneHourIn = computeRoomStates([v], [s], bkk(11));
    expect(oneHourIn.venues[0].current?.elapsedPercent).toBe(25);
    expect(oneHourIn.venues[0].current?.remainingMinutes).toBe(180);

    const almostOver = computeRoomStates([v], [s], bkk(13, 59));
    expect(
      almostOver.venues[0].current?.remainingMinutes,
    ).toBeGreaterThanOrEqual(1);
  });

  it('a cross-midnight slot marks startsBeforeToday / endsAfterToday correctly', () => {
    const v = venue({ id: 'v1' });
    // Starts 2026-01-04 (yesterday) 22:00, ends 2026-01-05 (today) 02:00 Bangkok.
    const crossMidnight: RoomSlotInput = slot({
      venueId: 'v1',
      startAt: new Date('2026-01-04T15:00:00.000Z'), // 22:00 Bangkok, Jan 4
      endAt: new Date('2026-01-04T19:00:00.000Z'), // 02:00 Bangkok, Jan 5
    });
    const result = computeRoomStates([v], [crossMidnight], bkk(1)); // 01:00 Bangkok Jan 5
    expect(result.venues[0].state).toBe('BUSY');
    expect(result.venues[0].current?.startsBeforeToday).toBe(true);
    expect(result.venues[0].current?.endsAfterToday).toBe(false);
  });
});
