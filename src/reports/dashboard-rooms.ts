import { bangkokDayRange } from '../bookings/booking-code';
import {
  bangkokDate,
  bangkokMinutesOfDay,
  isOperatingTime,
} from './report-calendar';

/**
 * `computeRoomStates` — the pure fold behind `GET /dashboard/venues-live` (design §2.3, §5). Takes
 * every non-deleted venue and today's APPROVED, non-cancelled slots, both already read by
 * `DashboardService` (Q-L), and derives busy/free/off, the free-window headline and the tab counts —
 * ALL AT ONE INSTANT, `now`, and with NO further I/O and NO ambient clock (D-2). Room names,
 * requester names and department names arrive already resolved (`requesterOf()`, D-18) — this file
 * does not know Prisma exists.
 */

const MS_PER_MINUTE = 60_000;

export interface RoomVenueInput {
  id: string;
  name: string;
  capacity: number;
  isOpen: boolean;
  closedReason: string | null;
}

/** One APPROVED, non-cancelled slot intersecting today at ONE venue. */
export interface RoomSlotInput {
  slotId: string;
  venueId: string;
  startAt: Date;
  endAt: Date;
  bookingRequestId: string;
  code: string;
  purpose: string;
  attendees: number;
  requesterName: string | null;
  departmentName: string | null;
}

/**
 * The domain enums live HERE, next to the logic that decides them, not in the DTO file — the DTO
 * (`dto/dashboard-venues-live.dto.ts`) imports them for its `@ApiProperty({ enum, enumName })`. Real
 * TS `enum`s, not string unions, because Swagger's `enumName` needs an object it can read keys off.
 */
export enum DashboardVenueState {
  BUSY = 'BUSY',
  FREE = 'FREE',
  OFF = 'OFF',
}

export enum DashboardFreeWindow {
  /** "ว่างจนถึง HH:MM น." — `next.startAt`. */
  UNTIL_NEXT = 'UNTIL_NEXT',
  /** serverTime < 12:00 → "ว่างตลอดทั้งวัน". */
  ALL_DAY = 'ALL_DAY',
  /** 12:00 ≤ serverTime ≤ 16:30 → "ว่างตลอดช่วงบ่าย". */
  AFTERNOON = 'AFTERNOON',
  /** serverTime > 16:30 → "ว่างจนถึงสิ้นวัน" (D-3, new copy). */
  REST_OF_DAY = 'REST_OF_DAY',
}

export type RoomState = DashboardVenueState;
export type FreeWindow = DashboardFreeWindow;

export interface ComputedCurrentSlot {
  slotId: string;
  bookingRequestId: string;
  code: string;
  startAt: Date;
  endAt: Date;
  startsBeforeToday: boolean;
  endsAfterToday: boolean;
  elapsedPercent: number;
  remainingMinutes: number;
  purpose: string;
  attendees: number;
  requesterName: string | null;
  departmentName: string | null;
}

export interface ComputedNextSlot {
  startAt: Date;
  endAt: Date;
  endsAfterToday: boolean;
  purpose: string;
}

export interface ComputedRoom {
  id: string;
  name: string;
  capacity: number;
  state: RoomState;
  closedReason: string | null;
  /** APPROVED non-cancelled slots intersecting today at this venue — reported even when OFF. */
  todaySlotCount: number;
  current: ComputedCurrentSlot | null;
  next: ComputedNextSlot | null;
  freeUntil: Date | null;
  freeWindow: FreeWindow | null;
}

export interface RoomStatesResult {
  serverTime: Date;
  today: string;
  withinOperatingHours: boolean;
  /** Card 3 value (D-4): Σ todaySlotCount over venues whose state ≠ OFF. */
  todayBookings: number;
  /** Card 3 desc N — same pass as the tab counts, so the two can never disagree (AC-D3). */
  inUseNow: number;
  counts: { all: number; busy: number; free: number; off: number };
  /** Order: BUSY → FREE → OFF, then the caller's own venue order (DB collation, then id). */
  venues: ComputedRoom[];
}

const STATE_RANK: Record<RoomState, number> = {
  [DashboardVenueState.BUSY]: 0,
  [DashboardVenueState.FREE]: 1,
  [DashboardVenueState.OFF]: 2,
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function computeRoomStates(
  venues: readonly RoomVenueInput[],
  slots: readonly RoomSlotInput[],
  now: Date,
): RoomStatesResult {
  const { start: todayStart, end: todayEnd } = bangkokDayRange(now);
  const nowMs = now.getTime();

  const slotsByVenue = new Map<string, RoomSlotInput[]>();
  for (const slot of slots) {
    const list = slotsByVenue.get(slot.venueId);
    if (list) list.push(slot);
    else slotsByVenue.set(slot.venueId, [slot]);
  }
  // Stable, deterministic ordering per venue regardless of the caller's read order.
  for (const list of slotsByVenue.values()) {
    list.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  }

  const rooms: ComputedRoom[] = venues.map((venue) => {
    const venueSlots = slotsByVenue.get(venue.id) ?? [];
    const todaySlotCount = venueSlots.length;

    if (!venue.isOpen) {
      return {
        id: venue.id,
        name: venue.name,
        capacity: venue.capacity,
        state: DashboardVenueState.OFF,
        closedReason: venue.closedReason ?? 'สถานที่นี้ปิดรับการจองชั่วคราว',
        todaySlotCount,
        current: null,
        next: null,
        freeUntil: null,
        freeWindow: null,
      };
    }

    // Half-open [startAt, endAt) — E-7: a slot ending exactly now is NOT current.
    const currentCandidates = venueSlots.filter(
      (s) => s.startAt.getTime() <= nowMs && nowMs < s.endAt.getTime(),
    );
    const currentSlot =
      currentCandidates.length > 0
        ? currentCandidates.reduce((earliest, s) =>
            s.startAt.getTime() < earliest.startAt.getTime() ? s : earliest,
          )
        : undefined;

    if (currentSlot) {
      const durationMs =
        currentSlot.endAt.getTime() - currentSlot.startAt.getTime();
      const elapsedPercent =
        durationMs > 0
          ? clampPercent(
              ((nowMs - currentSlot.startAt.getTime()) / durationMs) * 100,
            )
          : 100;
      const remainingMinutes = Math.max(
        1,
        Math.ceil((currentSlot.endAt.getTime() - nowMs) / MS_PER_MINUTE),
      );
      return {
        id: venue.id,
        name: venue.name,
        capacity: venue.capacity,
        state: DashboardVenueState.BUSY,
        closedReason: null,
        todaySlotCount,
        current: {
          slotId: currentSlot.slotId,
          bookingRequestId: currentSlot.bookingRequestId,
          code: currentSlot.code,
          startAt: currentSlot.startAt,
          endAt: currentSlot.endAt,
          startsBeforeToday:
            currentSlot.startAt.getTime() < todayStart.getTime(),
          endsAfterToday: currentSlot.endAt.getTime() > todayEnd.getTime(),
          elapsedPercent,
          remainingMinutes,
          purpose: currentSlot.purpose,
          attendees: currentSlot.attendees,
          requesterName: currentSlot.requesterName,
          departmentName: currentSlot.departmentName,
        },
        next: null,
        freeUntil: null,
        freeWindow: null,
      };
    }

    // FREE. Next = the earliest slot starting later today (D-8's "later today" ⇒ before tomorrow
    // 00:00 Bangkok), which is always true here because `slots` is already today-only input.
    const nextSlot = venueSlots
      .filter((s) => s.startAt.getTime() > nowMs)
      .reduce<RoomSlotInput | undefined>(
        (earliest, s) =>
          !earliest || s.startAt.getTime() < earliest.startAt.getTime()
            ? s
            : earliest,
        undefined,
      );

    let freeWindow: FreeWindow;
    let freeUntil: Date | null;
    if (nextSlot) {
      freeWindow = DashboardFreeWindow.UNTIL_NEXT;
      freeUntil = nextSlot.startAt;
    } else {
      freeUntil = null;
      const minutes = bangkokMinutesOfDay(now);
      if (minutes < 12 * 60) freeWindow = DashboardFreeWindow.ALL_DAY;
      else if (minutes <= 16 * 60 + 30)
        freeWindow = DashboardFreeWindow.AFTERNOON;
      else freeWindow = DashboardFreeWindow.REST_OF_DAY;
    }

    return {
      id: venue.id,
      name: venue.name,
      capacity: venue.capacity,
      state: DashboardVenueState.FREE,
      closedReason: null,
      todaySlotCount,
      current: null,
      next: nextSlot
        ? {
            startAt: nextSlot.startAt,
            endAt: nextSlot.endAt,
            endsAfterToday: nextSlot.endAt.getTime() > todayEnd.getTime(),
            purpose: nextSlot.purpose,
          }
        : null,
      freeUntil,
      freeWindow,
    };
  });

  // Stable sort: BUSY -> FREE -> OFF, ties keep the caller's order (DB collation, then id).
  const sorted = rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => {
      const rankDiff = STATE_RANK[a.room.state] - STATE_RANK[b.room.state];
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map((x) => x.room);

  const counts = {
    all: sorted.length,
    busy: sorted.filter((r) => r.state === DashboardVenueState.BUSY).length,
    free: sorted.filter((r) => r.state === DashboardVenueState.FREE).length,
    off: sorted.filter((r) => r.state === DashboardVenueState.OFF).length,
  };
  const todayBookings = sorted
    .filter((r) => r.state !== DashboardVenueState.OFF)
    .reduce((sum, r) => sum + r.todaySlotCount, 0);

  return {
    serverTime: now,
    today: bangkokDate(now),
    withinOperatingHours: isOperatingTime(now),
    todayBookings,
    inUseNow: counts.busy,
    counts,
    venues: sorted,
  };
}
