import { Injectable } from '@nestjs/common';
import { AppAccess, BookingStatus, Prisma } from '@prisma/client';
import { bangkokDayRange } from '../bookings/booking-code';
import {
  BOOKING_REQUESTER_SELECT,
  requesterOf,
} from '../bookings/booking-list-view';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeRoomStates,
  type RoomSlotInput,
  type RoomVenueInput,
} from './dashboard-rooms';
import {
  DashboardPendingItemDto,
  DashboardVitalsResponseDto,
} from './dto/dashboard-vitals.dto';
import { DashboardVenuesLiveResponseDto } from './dto/dashboard-venues-live.dto';
import { bangkokDate, dayOffset } from './report-calendar';
import { DASHBOARD_QUEUE_SIZE } from './reports.constants';

/** `PENDING` queue read — design §2.2 (Q-V). */
const QUEUE_SELECT = {
  id: true,
  code: true,
  purpose: true,
  firstStartAt: true,
  createdAt: true,
  ...BOOKING_REQUESTER_SELECT,
  // ⚠️ NO `deletedAt` FILTER on the venue read — a soft-deleted venue must still show in the queue
  // (E-8), flagged via `isDeleted` rather than disappearing.
  venue: { select: { id: true, name: true, deletedAt: true } },
  slots: {
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    select: { startAt: true, endAt: true, isCancelled: true },
  },
} satisfies Prisma.BookingRequestSelect;

type QueueRow = Prisma.BookingRequestGetPayload<{
  select: typeof QUEUE_SELECT;
}>;

/** Today's APPROVED, non-cancelled slot read — design §2.3 (Q-L). */
const TODAY_SLOT_SELECT = {
  id: true,
  venueId: true,
  startAt: true,
  endAt: true,
  bookingRequest: {
    select: {
      id: true,
      code: true,
      purpose: true,
      attendees: true,
      ...BOOKING_REQUESTER_SELECT,
    },
  },
} satisfies Prisma.BookingSlotSelect;

type TodaySlotRow = Prisma.BookingSlotGetPayload<{
  select: typeof TODAY_SLOT_SELECT;
}>;

/**
 * `DashboardController`'s two GETs — Hub 7's data (design §2.1, §2.2, §2.3). Deliberately imports
 * `booking-list-view.ts`'s pure exports directly rather than `BookingsModule`: this module is
 * read-only and must not pull in the write-heavy transactional module (design §2.1).
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getVitals(): Promise<DashboardVitalsResponseDto> {
    const serverTime = new Date();
    const today = bangkokDate(serverTime);

    const [pendingRequests, pendingLineUsers, queueRows] = await Promise.all([
      this.prisma.bookingRequest.count({
        where: { status: BookingStatus.PENDING },
      }),
      this.prisma.lineUser.count({
        where: { access: AppAccess.PENDING, deletedAt: null },
      }),
      this.prisma.bookingRequest.findMany({
        where: { status: BookingStatus.PENDING },
        orderBy: [
          { firstStartAt: 'asc' },
          { createdAt: 'asc' },
          { code: 'asc' },
        ],
        take: DASHBOARD_QUEUE_SIZE,
        select: QUEUE_SELECT,
      }),
    ]);

    return {
      serverTime,
      today,
      pendingRequests,
      pendingLineUsers,
      pendingQueue: queueRows.map((row) => this.toQueueItem(row, today)),
    };
  }

  private toQueueItem(row: QueueRow, today: string): DashboardPendingItemDto {
    const requester = requesterOf(row);
    const activeSlots = row.slots.filter((s) => !s.isCancelled);
    // A PENDING request cannot have a cancelled slot in practice (Q-C4: per-slot cancel needs
    // APPROVED), but the fallback keeps this mapper honest if that invariant is ever loosened.
    const firstSlot = activeSlots[0] ?? row.slots[0];
    return {
      id: row.id,
      code: row.code,
      requesterName: requester.name,
      departmentName: requester.departmentName,
      venue: {
        id: row.venue.id,
        name: row.venue.name,
        isDeleted: row.venue.deletedAt !== null,
      },
      purpose: row.purpose,
      firstSlot: { startAt: firstSlot.startAt, endAt: firstSlot.endAt },
      activeSlotCount:
        activeSlots.length > 0 ? activeSlots.length : row.slots.length,
      dayOffset: dayOffset(today, bangkokDate(firstSlot.startAt)),
      createdAt: row.createdAt,
    };
  }

  async getVenuesLive(): Promise<DashboardVenuesLiveResponseDto> {
    const now = new Date();
    const { start, end } = bangkokDayRange(now);

    const [venueRows, slotRows] = await Promise.all([
      this.prisma.venue.findMany({
        where: { deletedAt: null },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          capacity: true,
          isOpen: true,
          closedReason: true,
        },
      }),
      this.prisma.bookingSlot.findMany({
        where: {
          isCancelled: false,
          startAt: { lt: end },
          endAt: { gt: start },
          bookingRequest: { status: BookingStatus.APPROVED },
          venue: { deletedAt: null },
        },
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        select: TODAY_SLOT_SELECT,
      }),
    ]);

    const venues: RoomVenueInput[] = venueRows;
    const slots: RoomSlotInput[] = slotRows.map((row) =>
      this.toRoomSlotInput(row),
    );

    const result = computeRoomStates(venues, slots, now);

    return {
      serverTime: result.serverTime,
      today: result.today,
      withinOperatingHours: result.withinOperatingHours,
      todayBookings: result.todayBookings,
      inUseNow: result.inUseNow,
      counts: result.counts,
      venues: result.venues.map((room) => ({
        id: room.id,
        name: room.name,
        capacity: room.capacity,
        state: room.state,
        closedReason: room.closedReason,
        todaySlotCount: room.todaySlotCount,
        current: room.current,
        next: room.next,
        freeUntil: room.freeUntil,
        freeWindow: room.freeWindow,
      })),
    };
  }

  private toRoomSlotInput(row: TodaySlotRow): RoomSlotInput {
    const requester = requesterOf(row.bookingRequest);
    return {
      slotId: row.id,
      venueId: row.venueId,
      startAt: row.startAt,
      endAt: row.endAt,
      bookingRequestId: row.bookingRequest.id,
      code: row.bookingRequest.code,
      purpose: row.bookingRequest.purpose,
      attendees: row.bookingRequest.attendees,
      requesterName: requester.name,
      departmentName: requester.departmentName,
    };
  }
}
