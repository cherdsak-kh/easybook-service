import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdminBookingRequesterDto,
  AdminBookingRequestListItemDto,
  AdminBookingSlotDto,
} from './dto/admin-booking-response.dto';

/**
 * 🔴 THE SINGLE OWNER OF THE QUEUE ROW: the `select` that reads one, the mapper that turns it into
 * `AdminBookingRequestListItemDto`, and the by-id re-read the realtime fan-out needs.
 *
 * ── WHY IT IS ITS OWN FILE (`ADMIN-REALTIME-BOOKINGS-1`) ──
 * All of this was module-private inside `AdminBookingsService`, which was right while `GET
 * /booking-requests` was its only reader. It stopped being right the moment a SECOND caller —
 * `BookingsService.createFromLine`, on the LIFF side — had to produce the identical payload for a
 * socket event: the client's type is generated from this shape, so two producers would be two
 * chances for a field to drift, and a drifting field is a silent break rather than a loud one.
 *
 * The extraction is the same move `booking-overlap.ts` and `booking-code.ts` already made and for
 * the same stated reason (`bookings.module.ts`): what the two services genuinely share is EXTRACTED,
 * never duplicated and never reached for across a service boundary. It is a pure function module —
 * no provider, no instance to substitute, no way for one caller to get a different row shape from
 * the other. Behaviour-preserving: nothing below changed on the way out of the service.
 */

/**
 * Every slot of the booking, cancelled ones included, oldest first.
 *
 * ⚠️ THE OPPOSITE OF THE AVAILABILITY READ, deliberately. The calendar must not paint a freed hour;
 * the approval screen must show that Wednesday was dropped and why, or a three-day booking silently
 * becomes a two-day one with no trace of the decision.
 */
const ADMIN_SLOTS = {
  orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
} satisfies Prisma.BookingRequest$slotsArgs;

/**
 * ⚠️ NOT ONE NESTED READ CARRIES A `deletedAt` FILTER, and that is this repo's read/write asymmetry
 * rather than an oversight (`CLAUDE.md`, `SystemUser.departmentId`). A LINE user who unfollowed, a
 * department that was retired, a staff member who was soft-deleted: each must still resolve on a
 * booking that already happened. Filtering here would blank a name on a historical row — and on the
 * non-nullable staff fields it would 500 the list instead.
 */
export const BOOKING_REQUESTER_SELECT = {
  requesterName: true,
  contactPhone: true,
  department: { select: { name: true } },
  lineUser: {
    select: {
      registration: {
        select: {
          firstName: true,
          lastName: true,
          phone: true,
          // ⚠️ THE REGISTRATION'S OWN DEPARTMENT, not `BookingRequest.departmentId`. That column is
          // the ADMIN origin's override and is null on every LIFF request; a LINE user's department
          // is the one they registered with, resolved through this FK and nowhere else.
          department: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.BookingRequestSelect;

/**
 * ⛔ `holdsSlot` IS ABSENT AND MUST STAY ABSENT. It is the index key the database owns, not a fact
 * about the domain (`schema.prisma`). ⛔ `cancelledById` is absent too: a raw id into one of two
 * unbridged tables that no client can resolve — the schema says outright "Do not `include` it".
 */
const SLOT_SELECT = {
  id: true,
  startAt: true,
  endAt: true,
  isCancelled: true,
  cancelledAt: true,
  cancelReason: true,
  cancelledByRole: true,
} satisfies Prisma.BookingSlotSelect;

export const BOOKING_LIST_SELECT = {
  id: true,
  code: true,
  status: true,
  createdById: true,
  purpose: true,
  attendees: true,
  firstStartAt: true,
  lastEndAt: true,
  rejectReason: true,
  createdAt: true,
  ...BOOKING_REQUESTER_SELECT,
  venue: { select: { id: true, name: true, location: true } },
  slots: { ...ADMIN_SLOTS, select: SLOT_SELECT },
} satisfies Prisma.BookingRequestSelect;

export type BookingListRow = Prisma.BookingRequestGetPayload<{
  select: typeof BOOKING_LIST_SELECT;
}>;

/**
 * Who the booking is FOR, from whichever origin wrote the row (`D-C18`).
 *
 * 🔴 THE REGISTRATION WINS WHEN THERE IS ONE. The three override columns are null on a LIFF request
 * by contract, and on a staff booking made ON BEHALF OF a LINE user they are refused at the DTO
 * boundary — so "has a registration" is the only branch needed, and it never has to choose between
 * two populated sources.
 *
 * `null` is a legitimate answer throughout: a staff booking whose department was not filled in, or a
 * LINE user who has not registered yet, is an internal event rather than a broken row.
 */
export function requesterOf(row: {
  requesterName: string | null;
  contactPhone: string | null;
  department: { name: string } | null;
  lineUser: {
    registration: {
      firstName: string;
      lastName: string;
      phone: string;
      department: { name: string } | null;
    } | null;
  } | null;
}): AdminBookingRequesterDto {
  const reg = row.lineUser?.registration;
  if (reg) {
    return {
      name: `${reg.firstName} ${reg.lastName}`.trim() || null,
      phone: reg.phone,
      departmentName: reg.department?.name ?? null,
    };
  }
  return {
    name: row.requesterName,
    phone: row.contactPhone,
    departmentName: row.department?.name ?? null,
  };
}

function toSlotDto(slot: {
  id: string;
  startAt: Date;
  endAt: Date;
  isCancelled: boolean;
  cancelledAt: Date | null;
  cancelReason: string | null;
  cancelledByRole: string | null;
}): AdminBookingSlotDto {
  return {
    id: slot.id,
    startAt: slot.startAt,
    endAt: slot.endAt,
    isCancelled: slot.isCancelled,
    cancelledAt: slot.cancelledAt,
    cancelReason: slot.cancelReason,
    cancelledByRole: slot.cancelledByRole,
  };
}

export function toBookingListDto(
  row: BookingListRow,
  now: Date,
): AdminBookingRequestListItemDto {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    // `createdById === null` ⇒ nobody on staff typed it ⇒ it came from LINE.
    origin: row.createdById === null ? 'LINE' : 'ADMIN',
    // Computed at read time against the SERVER's clock. No fifth status, no cron.
    isExpired:
      row.status === BookingStatus.PENDING &&
      row.lastEndAt.getTime() < now.getTime(),
    requester: requesterOf(row),
    venue: row.venue,
    purpose: row.purpose,
    attendees: row.attendees,
    firstStartAt: row.firstStartAt,
    lastEndAt: row.lastEndAt,
    slots: row.slots.map(toSlotDto),
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
  };
}

/**
 * Re-reads the named requests in the QUEUE ROW shape and maps them — ONE query for the whole batch,
 * never one per id (an approval that bumps five losers is still a single `findMany`).
 *
 * 🔴 IT TAKES `PrismaService`, NOT `Prisma.TransactionClient`, AND THAT IS THE POINT. A transaction
 * client is not assignable to it, so the compiler refuses the one call this function must never
 * serve: reading — and therefore announcing — a change from INSIDE the transaction that made it. A
 * rolled-back transaction that already told every other screen it had committed is worse than one
 * that told nobody.
 *
 * ⚠️ THE ORDER IS THE CALLER'S, not the database's, because the subject must reach the wire before
 * the losers it displaced. An id that no longer resolves — deleted between the commit and this read
 * — is dropped rather than faked: there is no honest row to broadcast for it.
 */
export async function readBookingListDtos(
  prisma: PrismaService,
  ids: readonly string[],
): Promise<AdminBookingRequestListItemDto[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.bookingRequest.findMany({
    where: { id: { in: [...ids] } },
    select: BOOKING_LIST_SELECT,
  });
  const now = new Date();
  const byId = new Map(rows.map((row) => [row.id, toBookingListDto(row, now)]));
  return ids
    .map((id) => byId.get(id))
    .filter((dto): dto is AdminBookingRequestListItemDto => dto !== undefined);
}
