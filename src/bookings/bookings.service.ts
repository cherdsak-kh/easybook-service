import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppAccess, BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { bangkokDayRange, formatBookingCode } from './booking-code';
import {
  AVAILABILITY_MAX_DAYS,
  AVAILABILITY_RANGE_INVALID,
  AVAILABILITY_RANGE_TOO_WIDE,
  BANGKOK_UTC_OFFSET_MINUTES,
  BOOKING_CODE_MAX_ATTEMPTS,
  BOOKING_NOT_ALLOWED,
  SLOT_IN_THE_PAST,
  SLOT_RANGE_INVALID,
  SLOT_SELF_OVERLAP,
  SLOT_TAKEN,
  VENUE_CLOSED,
  VENUE_NOT_FOUND,
} from './bookings.constants';
import type {
  BookingRequestResponseDto,
  VenueAvailabilitySlotDto,
} from './dto/booking-response.dto';
import type { CreateLineBookingDto } from './dto/create-line-booking.dto';
import type { VenueAvailabilityQueryDto } from './dto/venue-availability-query.dto';

/** A slot after parsing, with real `Date`s instead of the DTO's strings. */
type ParsedSlot = { start: Date; end: Date };

/**
 * ⚠️ ONLY THESE TWO STATUSES OCCUPY A CALENDAR. `REJECTED` and `CANCELLED` requests hold nothing and
 * must never be painted — a rejected request still owns its `booking_slots` rows, so filtering on
 * the parent's status is not optional.
 */
const OCCUPYING_STATUSES = [
  BookingStatus.APPROVED,
  BookingStatus.PENDING,
] as const;

/**
 * What the availability read needs from each slot's parent, and nothing else.
 *
 * ⚠️ THE NESTED REGISTRATION READ CARRIES NO `deletedAt` FILTER, which is this repo's read/write
 * asymmetry (`CLAUDE.md`, `SystemUser.departmentId`): a LINE user who has since unfollowed — and is
 * therefore soft-deleted — must still resolve as the requester of a booking that already happened.
 * Filtering here would blank the name on historical rows rather than protect anything.
 */
const AVAILABILITY_INCLUDE = {
  bookingRequest: {
    select: {
      status: true,
      purpose: true,
      lineUserId: true,
      requesterName: true,
      lineUser: {
        select: {
          registration: { select: { firstName: true, lastName: true } },
        },
      },
    },
  },
} satisfies Prisma.BookingSlotInclude;

type AvailabilityRow = Prisma.BookingSlotGetPayload<{
  include: typeof AVAILABILITY_INCLUDE;
}>;

/**
 * `CLIENT-BOOKING-1`, client half — the LIFF end-user's two booking touchpoints.
 *
 * ── WHAT THIS SERVICE DOES NOT DO, AND WHERE IT LIVES INSTEAD ──
 * `SERVICE_CHANGES.md` §2.3.1 describes two lifecycles over one table. This file implements the
 * FIRST one only: a LINE user submits a `PENDING` request, and anybody may read a venue's occupied
 * spans. The second — the admin direct booking, approval, and the auto-rejection of every
 * overlapping `PENDING` request inside the approval transaction — is a `SessionGuard` surface that
 * does not exist yet and is a separate task. Nothing here approves anything.
 *
 * 🔴 THE CONSEQUENCE, STATED PLAINLY: `assertNoApprovedClash` below is a COURTESY, not the
 * correctness boundary ADR-001 talks about. It has to be, because of `D-C13` rule 4 — a `PENDING`
 * request holds nothing, several people may hold overlapping pending requests at once, and that is
 * the designed behaviour rather than a race to be closed. The real double-booking boundary is the
 * approval transaction, and it needs a database-level exclusion constraint that this migration does
 * not yet carry. Do not read the check below as that constraint arriving early.
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `POST /line-users/bookings`.
   *
   * ⚠️ ORDER OF REFUSALS IS DELIBERATE: authorise, then validate the payload, then look at the
   * venue. A caller who is not `ALLOWED` must not be able to use this endpoint as an existence
   * oracle for venue ids — they get the same 403 whatever they ask for.
   */
  async createFromLine(
    lineSub: string,
    dto: CreateLineBookingDto,
  ): Promise<BookingRequestResponseDto> {
    const requester = await this.resolveAllowedRequester(lineSub);
    const slots = parseSlots(dto.slots);

    const venue = await this.prisma.venue.findFirst({
      where: { id: dto.venueId, deletedAt: null },
      select: { id: true, name: true, isOpen: true },
    });
    if (!venue) throw new NotFoundException(VENUE_NOT_FOUND);
    // The server half of the disabled CTA. A closed venue stays VISIBLE and refuses NEW requests;
    // the button on the detail screen is UX, and UX is not an authorisation boundary.
    if (!venue.isOpen) throw new ConflictException(VENUE_CLOSED);

    const row = await this.insertWithCode(venue.id, requester.id, dto, slots);
    return toRequestDto(row, venue.name);
  }

  /**
   * `GET /line-users/venues/:id/availability`.
   *
   * Returns every occupying slot that OVERLAPS the window — not every slot contained by it. A
   * two-day camp that started before `from` still occupies the first day of the range, and dropping
   * it would draw a free morning that is not free.
   */
  async listVenueAvailability(
    lineSub: string,
    venueId: string,
    query: VenueAvailabilityQueryDto,
  ): Promise<VenueAvailabilitySlotDto[]> {
    const requester = await this.resolveAllowedRequester(lineSub);
    const { from, to } = resolveWindow(query);

    // 404 before the slot read, so an unknown id answers the same way `GET /line-users/venues/:id`
    // does rather than returning a plausible empty calendar for a room that does not exist.
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true },
    });
    if (!venue) throw new NotFoundException(VENUE_NOT_FOUND);

    const rows = await this.prisma.bookingSlot.findMany({
      where: {
        venueId: venue.id,
        isCancelled: false,
        bookingRequest: { status: { in: [...OCCUPYING_STATUSES] } },
        startAt: { lt: to },
        endAt: { gt: from },
      },
      include: AVAILABILITY_INCLUDE,
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => toAvailabilityDto(row, requester.id));
  }

  /**
   * Identity and permission in one read.
   *
   * 🔴 THE `sub` IS THE ONLY INPUT (`LINK-LINE-1`). It is the LINE-side `U…` string, so it matches
   * `LineUser.lineUserId` — NOT `LineUser.id`, which is the cuid every FK in the booking tables
   * points at. Confusing the two type-checks and returns `null` forever; that footgun is documented
   * on three models in `schema.prisma` and has cost this project time before.
   *
   * A soft-deleted user (unfollowed the OA) is treated as absent: same 403, no oracle.
   */
  private async resolveAllowedRequester(
    lineSub: string,
  ): Promise<{ id: string }> {
    const user = await this.prisma.lineUser.findFirst({
      where: { lineUserId: lineSub, deletedAt: null },
      select: { id: true, access: true },
    });
    if (!user || user.access !== AppAccess.ALLOWED) {
      throw new ForbiddenException(BOOKING_NOT_ALLOWED);
    }
    return { id: user.id };
  }

  /**
   * The write, wrapped in the retry the `code` column's uniqueness needs.
   *
   * ⚠️ THE RETRY IS AROUND THE WHOLE TRANSACTION, not inside it. A `P2002` aborts the transaction,
   * so the second attempt has to be a new one — and it recounts, which is the point: it now sees the
   * row that beat it.
   */
  private async insertWithCode(
    venueId: string,
    lineUserId: string,
    dto: CreateLineBookingDto,
    slots: ParsedSlot[],
  ): Promise<CreatedRow> {
    for (let attempt = 1; attempt <= BOOKING_CODE_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.insertOnce(venueId, lineUserId, dto, slots);
      } catch (err) {
        if (!isCodeCollision(err) || attempt === BOOKING_CODE_MAX_ATTEMPTS) {
          throw err;
        }
        // id only — `purpose`, `requesterName` and `contactPhone` are PII and are never logged.
        this.logger.warn(
          `Booking code collision on venue=${venueId}; retrying (attempt ${attempt}).`,
        );
      }
    }
    // Unreachable: the loop either returns or rethrows on its last attempt.
    throw new InternalServerErrorException();
  }

  private insertOnce(
    venueId: string,
    lineUserId: string,
    dto: CreateLineBookingDto,
    slots: ParsedSlot[],
  ): Promise<CreatedRow> {
    return this.prisma.$transaction(async (tx) => {
      await assertNoApprovedClash(tx, venueId, slots);

      const now = new Date();
      const { start, end } = bangkokDayRange(now);
      const sameDayCount = await tx.bookingRequest.count({
        where: { createdAt: { gte: start, lt: end } },
      });

      return tx.bookingRequest.create({
        data: {
          code: formatBookingCode(now, sameDayCount),
          venueId,
          // 🔴 The LIFF origin writes `lineUserId` and NOTHING ELSE about the requester (`D-C18`).
          // `createdById`, `requesterName`, `contactPhone` and `departmentId` are the ADMIN origin's
          // columns and stay null; name, phone and department are read through this FK. The
          // `booking_requests_owner_check` constraint is satisfied by this one column.
          lineUserId,
          purpose: dto.purpose,
          attendees: dto.attendees,
          // `D-C13` rule 1 — a client booking is a REQUEST. `approvedById`/`approvedAt` stay null.
          status: BookingStatus.PENDING,
          // The denormalised span, computed here and only here, in the same statement as the slots
          // it summarises — so the cache cannot be written without its source.
          firstStartAt: new Date(
            Math.min(...slots.map((s) => s.start.getTime())),
          ),
          lastEndAt: new Date(Math.max(...slots.map((s) => s.end.getTime()))),
          slots: {
            // `venueId` is repeated onto every child on purpose: the schema's writer's contract is
            // that `BookingSlot.venueId === BookingRequest.venueId`, nothing in Prisma can enforce
            // it, and this is the single transaction allowed to write both from one value.
            create: slots.map((s) => ({
              venueId,
              startAt: s.start,
              endAt: s.end,
            })),
          },
        },
        include: { slots: { orderBy: [{ startAt: 'asc' }, { id: 'asc' }] } },
      });
    });
  }
}

type CreatedRow = Prisma.BookingRequestGetPayload<{
  include: { slots: true };
}>;

/**
 * Refuses a request that collides with an APPROVED, non-cancelled slot at the same venue.
 *
 * 🔴 APPROVED ONLY. A `PENDING` clash is NOT an error (`D-C13` rule 4) — several people may request
 * the same hours and all of them get `PENDING`; the approver picks one and the losers are
 * auto-rejected. Refusing here on a pending clash would silently turn the product into
 * first-to-submit-wins and delete the decision approval exists to make.
 *
 * ⚠️ Half-open intervals: `a.start < b.end && a.end > b.start`. A slot ending 12:00 and one starting
 * 12:00 do not overlap, and writing this with `<=` produces phantom conflicts nobody can reproduce.
 *
 * ⚠️ The refusal names nothing — not who holds the slot, not what for (`D-C13`).
 */
async function assertNoApprovedClash(
  tx: Prisma.TransactionClient,
  venueId: string,
  slots: ParsedSlot[],
): Promise<void> {
  const clash = await tx.bookingSlot.findFirst({
    where: {
      venueId,
      isCancelled: false,
      bookingRequest: { status: BookingStatus.APPROVED },
      OR: slots.map((s) => ({
        startAt: { lt: s.end },
        endAt: { gt: s.start },
      })),
    },
    select: { id: true },
  });
  if (clash) throw new ConflictException(SLOT_TAKEN);
}

/**
 * Strings → `Date`s, with the three semantic checks `class-validator` cannot express: a span must
 * end after it starts, must not start in the past, and must not overlap another span of the SAME
 * request.
 */
function parseSlots(
  input: readonly { startAt: string; endAt: string }[],
): ParsedSlot[] {
  const now = Date.now();
  const slots = input.map(({ startAt, endAt }) => {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException(SLOT_RANGE_INVALID);
    }
    // 🔴 `D-C16` — compared against NOW, never against midnight today. It is still legitimate at
    // 09:00 to book this afternoon, and a same-day comparison would refuse it.
    if (start.getTime() <= now) {
      throw new BadRequestException(SLOT_IN_THE_PAST);
    }
    return { start, end };
  });

  // n² over at most `BOOKING_SLOTS_MAX` entries — 60 is 1,770 comparisons, and sorting first to get
  // an O(n log n) sweep would mean reordering the caller's slots or carrying indices to report on.
  const sorted = [...slots].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start.getTime() < sorted[i - 1].end.getTime()) {
      throw new BadRequestException(SLOT_SELF_OVERLAP);
    }
  }
  return slots;
}

/**
 * The availability window: what the caller asked for, or the current Bangkok calendar month.
 *
 * ⚠️ BANGKOK, NOT THE SERVER'S CLOCK. "This month" has to mean the month the user is looking at on
 * a phone in Thailand; a UTC container would default the first seven hours of every 1st of the month
 * to the previous one and open the calendar on the wrong page.
 */
function resolveWindow(query: VenueAvailabilityQueryDto): {
  from: Date;
  to: Date;
} {
  const offset = BANGKOK_UTC_OFFSET_MINUTES * 60_000;
  const nowLocal = new Date(Date.now() + offset);
  const monthStart = new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), 1) - offset,
  );
  const monthEnd = new Date(
    Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth() + 1, 1) - offset,
  );

  const from = query.from ? new Date(query.from) : monthStart;
  const to = query.to ? new Date(query.to) : monthEnd;

  if (to.getTime() < from.getTime()) {
    throw new BadRequestException(AVAILABILITY_RANGE_INVALID);
  }
  if (to.getTime() - from.getTime() > AVAILABILITY_MAX_DAYS * 86_400_000) {
    throw new BadRequestException(AVAILABILITY_RANGE_TOO_WIDE);
  }
  return { from, to };
}

function toRequestDto(
  row: CreatedRow,
  venueName: string,
): BookingRequestResponseDto {
  return {
    id: row.id,
    code: row.code,
    venueId: row.venueId,
    venueName,
    purpose: row.purpose,
    attendees: row.attendees,
    status: row.status,
    firstStartAt: row.firstStartAt,
    lastEndAt: row.lastEndAt,
    slots: row.slots.map((s) => ({
      id: s.id,
      startAt: s.startAt,
      endAt: s.endAt,
      isCancelled: s.isCancelled,
    })),
    createdAt: row.createdAt,
  };
}

/**
 * 🔴 WHERE `D-C13`'s PRIVACY CLAUSE IS ACTUALLY ENFORCED. Both strings are omitted by the SERVER on
 * somebody else's unapproved request — a client that chose not to render them would not be a privacy
 * boundary, because the payload would still be on the wire.
 */
function toAvailabilityDto(
  row: AvailabilityRow,
  callerLineUserId: string,
): VenueAvailabilitySlotDto {
  const req = row.bookingRequest;
  const isMine = req.lineUserId === callerLineUserId;
  const isApproved = req.status === BookingStatus.APPROVED;
  const mayReveal = isApproved || isMine;

  return {
    id: row.id,
    startAt: row.startAt,
    endAt: row.endAt,
    // The `where` above admits only these two, so the cast records a filter rather than widening one.
    status: req.status as typeof BookingStatus.APPROVED,
    isMine,
    purpose: mayReveal ? req.purpose : null,
    requesterName: mayReveal ? requesterNameOf(req) : null,
  };
}

/**
 * The requester's name, from whichever origin wrote the row (`D-C18`).
 *
 * A LIFF request reads it through `lineUserId` → `LineUserRegistration`; a staff-created booking
 * uses the `requesterName` override. `null` is a legitimate answer for a staff booking with no
 * override — an unnamed approved slot is an internal event, not a broken row.
 */
function requesterNameOf(
  req: AvailabilityRow['bookingRequest'],
): string | null {
  const reg = req.lineUser?.registration;
  if (reg) return `${reg.firstName} ${reg.lastName}`.trim() || null;
  return req.requesterName ?? null;
}

/** A `P2002` naming the `code` column — the only unique constraint a create here can trip. */
function isCodeCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes('code') : target === 'code';
}
