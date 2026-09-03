import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppAccess, BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TOMBSTONE_VENUE_TYPE_NAME } from '../venue-types/venue-types.constants';
import { bangkokDayRange, formatBookingCode } from './booking-code';
import {
  AVAILABILITY_MAX_DAYS,
  AVAILABILITY_RANGE_INVALID,
  AVAILABILITY_RANGE_TOO_WIDE,
  BANGKOK_UTC_OFFSET_MINUTES,
  BOOKING_CODE_MAX_ATTEMPTS,
  BOOKING_NOT_ALLOWED,
  BOOKING_NOT_APPROVED,
  BOOKING_NOT_FOUND,
  BOOKING_NOT_PENDING,
  CANCEL_LEAD_MINUTES_DEFAULT,
  CANCEL_LEAD_MINUTES_KEY,
  CANCELLED_BY_LINE_USER,
  SLOT_ALREADY_CANCELLED,
  SLOT_CANCEL_TOO_LATE,
  SLOT_IN_THE_PAST,
  SLOT_NOT_FOUND,
  SLOT_RANGE_INVALID,
  SLOT_SELF_OVERLAP,
  SLOT_TAKEN,
  VENUE_CLOSED,
  VENUE_NOT_FOUND,
} from './bookings.constants';
import type {
  BookingDetailResponseDto,
  BookingListItemDto,
  BookingRequestResponseDto,
  BookingSlotResponseDto,
  VenueAvailabilitySlotDto,
} from './dto/booking-response.dto';
import type { CreateLineBookingDto } from './dto/create-line-booking.dto';
import type {
  BookingSort,
  ListLineBookingsQueryDto,
} from './dto/list-line-bookings-query.dto';
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
 * Slots as their OWNER reads them, oldest first.
 *
 * ⚠️ CANCELLED SLOTS ARE INCLUDED, and that is the opposite of {@link AVAILABILITY_INCLUDE}'s rule.
 * The calendar must not paint a freed hour; the owner's own detail screen must still show that
 * Wednesday was dropped, or a three-day request silently becomes a two-day one with no explanation
 * and the user has no way to see what they did.
 */
const OWNED_SLOTS = {
  orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
} satisfies Prisma.BookingRequest$slotsArgs;

/**
 * The venue a booking CARD needs. See {@link BookingVenueSummaryDto}.
 *
 * ⚠️ NO `deletedAt` FILTER ANYWHERE IN HERE — the read half of this repo's asymmetry. A booking
 * against a venue whose category was later retired must keep resolving that category's name;
 * filtering would put `null` into a non-nullable DTO field and 500 the whole list.
 */
const VENUE_CARD_SELECT = {
  id: true,
  name: true,
  location: true,
  venueType: { select: { id: true, name: true, isSystemReserved: true } },
  photos: {
    select: { id: true, url: true, position: true },
    // `id` as the tiebreak, so a duplicated `position` degrades to a stable but arbitrary order
    // rather than a cover that changes between two reads of the same row (`VenuePhoto`).
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.VenueSelect;

/** The venue the DETAIL screen needs: the card's fields plus what the user checks a room against. */
const VENUE_DETAIL_SELECT = {
  ...VENUE_CARD_SELECT,
  capacity: true,
  isOpen: true,
  amenities: {
    // The one place a `deletedAt` filter DOES belong: an amenity is a claim about the room right
    // now ("this hall has a projector"), and a retired one must stop printing. Mirrors
    // `VenuesService.PUBLIC_INCLUDE` exactly — the two must not drift.
    where: { amenity: { deletedAt: null } },
    select: { amenity: { select: { id: true, name: true } } },
    orderBy: { amenity: { name: 'asc' } },
  },
} satisfies Prisma.VenueSelect;

const LIST_INCLUDE = {
  venue: { select: VENUE_CARD_SELECT },
  slots: OWNED_SLOTS,
} satisfies Prisma.BookingRequestInclude;

const DETAIL_INCLUDE = {
  venue: { select: VENUE_DETAIL_SELECT },
  slots: OWNED_SLOTS,
} satisfies Prisma.BookingRequestInclude;

type ListRow = Prisma.BookingRequestGetPayload<{
  include: typeof LIST_INCLUDE;
}>;
type DetailRow = Prisma.BookingRequestGetPayload<{
  include: typeof DETAIL_INCLUDE;
}>;

/**
 * The four orderings, resolved to Prisma.
 *
 * ⚠️ EVERY ONE ENDS IN `code: 'asc'`, which makes the order TOTAL. Two requests submitted in the
 * same second are otherwise ordered by whatever Postgres feels like, so the same list re-fetched
 * after a cancel can shuffle two rows past each other — and a list that reorders under a user who
 * did not ask it to reads as data loss. `code` is the prototype's own tiebreak (`a.id` there IS
 * this `code`).
 *
 * ⚠️ `event-*` ORDERS ON `firstStartAt`, NOT ON THE SLOTS. Ordering through a relation is not
 * expressible in this repo's pagination rule, which is the reason the denormalised pair exists at
 * all (`schema.prisma`) — and the cancel path below is what keeps it honest.
 */
const SORT_ORDER: Record<
  BookingSort,
  Prisma.BookingRequestOrderByWithRelationInput[]
> = {
  'created-desc': [{ createdAt: 'desc' }, { code: 'asc' }],
  'created-asc': [{ createdAt: 'asc' }, { code: 'asc' }],
  'event-asc': [{ firstStartAt: 'asc' }, { code: 'asc' }],
  'event-desc': [{ firstStartAt: 'desc' }, { code: 'asc' }],
};

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
   * `GET /line-users/bookings` — My Bookings.
   *
   * 🔴 OWNERSHIP IS A `where` CLAUSE, NEVER A FILTER AFTER THE READ. `lineUserId` is fixed from the
   * verified `sub` and combined with the caller's `q`/`status`, so there is no code path on which a
   * search term can widen the result set past its author. A post-read `.filter()` would put one
   * forgotten `return` between a typo and every booking in the product.
   */
  async listUserBookings(
    lineSub: string,
    query: ListLineBookingsQueryDto,
  ): Promise<BookingListItemDto[]> {
    const requester = await this.resolveAllowedRequester(lineSub);

    const rows = await this.prisma.bookingRequest.findMany({
      where: {
        lineUserId: requester.id,
        ...(query.status ? { status: query.status } : {}),
        ...searchWhere(query.q),
      },
      include: LIST_INCLUDE,
      orderBy: SORT_ORDER[query.sort],
    });

    return rows.map(toListDto);
  }

  /**
   * `GET /line-users/bookings/:id` — addressed by cuid **or** by `code`.
   *
   * ⚠️ TWO KEYS FOR ONE ROW, DELIBERATELY. `#/booking/:id` navigates by cuid; `#/sent/:id` knows
   * only the `BR-…` number it just printed, and the user's own paste of it out of a LINE chat is the
   * third caller. Making the confirmation screen carry a cuid it never saw, or making the search box
   * resolve a code to an id first, would both be a round trip to avoid one `OR`.
   */
  async getUserBookingDetail(
    lineSub: string,
    idOrCode: string,
  ): Promise<BookingDetailResponseDto> {
    const requester = await this.resolveAllowedRequester(lineSub);
    return this.readDetail(ownedBookingWhere(idOrCode, requester.id));
  }

  /**
   * `PATCH /line-users/bookings/:id/cancel` — withdraw a request the approver has not ruled on.
   *
   * `Q-C4`: `PENDING` is the ONLY cancellable-as-a-whole state. An `APPROVED` booking is cancelled
   * one slot at a time ({@link cancelApprovedSlot}), and `REJECTED`/`CANCELLED` are terminal.
   *
   * 🔴 THE STATE CHECK IS THE CONDITIONAL UPDATE, NOT THE `if`. The read-then-write between two
   * concurrent taps — a double-tap on a phone is the ordinary case, not an exotic one — would let
   * both pass the `if` and both write. `updateMany({ where: { id, status: PENDING } })` makes
   * Postgres the arbiter and the loser sees `count: 0`, which is ADR-001's rule applied to a state
   * machine rather than to an overlap.
   *
   * ⚠️ `firstStartAt`/`lastEndAt` ARE NOT RECOMPUTED HERE, which is the same rule the per-slot path
   * follows when the last slot goes: a request with nothing live keeps the span it last had, because
   * the history group still has to sort it by a date and "when was this going to be" is the only
   * date it has. Recomputing over an empty set has no answer that is not a lie.
   */
  async cancelPendingBooking(
    lineSub: string,
    idOrCode: string,
  ): Promise<BookingDetailResponseDto> {
    const requester = await this.resolveAllowedRequester(lineSub);
    const where = ownedBookingWhere(idOrCode, requester.id);
    const now = new Date();

    const id = await this.prisma.$transaction(async (tx) => {
      const booking = await tx.bookingRequest.findFirst({
        where,
        select: { id: true, status: true },
      });
      if (!booking) throw new NotFoundException(BOOKING_NOT_FOUND);
      if (booking.status !== BookingStatus.PENDING) {
        throw new UnprocessableEntityException(BOOKING_NOT_PENDING);
      }

      const flipped = await tx.bookingRequest.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING },
        data: { status: BookingStatus.CANCELLED },
      });
      if (flipped.count !== 1) {
        throw new UnprocessableEntityException(BOOKING_NOT_PENDING);
      }

      // `Q-C4` ②: the truth lives at slot level. Flipping the parent without its children would
      // leave live slots under a cancelled request — rows the availability read still paints.
      await tx.bookingSlot.updateMany({
        where: { bookingRequestId: booking.id, isCancelled: false },
        data: cancellation(now, requester.id),
      });
      return booking.id;
    });

    return this.readDetail({ id });
  }

  /**
   * `PATCH /line-users/bookings/:id/slots/:slotId/cancel` — drop one day of an approved booking.
   *
   * `Q-C4` ②, in full: a three-slot request whose Monday has already begun can still have its
   * Tuesday and Wednesday cancelled, the check runs against **that slot's** `startAt`, and only that
   * slot is freed.
   *
   * 🔴 THE CANCELLED SLOT FREES THE CALENDAR IMMEDIATELY. `listVenueAvailability` filters on
   * `isCancelled: false` at SLOT level, so the hour is green again on the next read — no job, no
   * cache, nothing to invalidate. Requests previously auto-rejected for it are NOT revived
   * (`Q-C4`): the user has probably made other plans, and they are told the slot is free instead.
   *
   * ⚠️ THE DENORMALISED SPAN IS RECOMPUTED IN THE SAME TRANSACTION, which is `schema.prisma`'s
   * writer's contract for these two columns rather than a nicety. They are a cache of the children,
   * and a stale one here does not error — it silently mis-sorts My Bookings and mis-filters the
   * approval queue.
   */
  async cancelApprovedSlot(
    lineSub: string,
    idOrCode: string,
    slotId: string,
  ): Promise<BookingDetailResponseDto> {
    const requester = await this.resolveAllowedRequester(lineSub);
    const where = ownedBookingWhere(idOrCode, requester.id);
    const leadMinutes = await this.cancelLeadMinutes();
    const now = new Date();
    // 🔴 NOW PLUS THE LEAD TIME, compared against the real clock — the same `D-C16` reasoning that
    // governs submission. A slot that has already started is refused by this one comparison too,
    // because it is even further in the past than the cutoff.
    const cutoff = now.getTime() + leadMinutes * 60_000;

    const id = await this.prisma.$transaction(async (tx) => {
      const booking = await tx.bookingRequest.findFirst({
        where,
        select: { id: true, status: true },
      });
      if (!booking) throw new NotFoundException(BOOKING_NOT_FOUND);
      if (booking.status !== BookingStatus.APPROVED) {
        throw new UnprocessableEntityException(BOOKING_NOT_APPROVED);
      }

      // Scoped to the parent, so a slot id belonging to somebody else's booking is a 404 rather
      // than a cancellation of a stranger's Tuesday.
      const slot = await tx.bookingSlot.findFirst({
        where: { id: slotId, bookingRequestId: booking.id },
        select: { id: true, startAt: true, isCancelled: true },
      });
      if (!slot) throw new NotFoundException(SLOT_NOT_FOUND);
      if (slot.isCancelled) {
        throw new UnprocessableEntityException(SLOT_ALREADY_CANCELLED);
      }
      if (slot.startAt.getTime() <= cutoff) {
        throw new UnprocessableEntityException(SLOT_CANCEL_TOO_LATE);
      }

      const cancelled = await tx.bookingSlot.updateMany({
        where: { id: slot.id, isCancelled: false },
        data: cancellation(now, requester.id),
      });
      if (cancelled.count !== 1) {
        throw new UnprocessableEntityException(SLOT_ALREADY_CANCELLED);
      }

      const remaining = await tx.bookingSlot.findMany({
        where: { bookingRequestId: booking.id, isCancelled: false },
        select: { startAt: true, endAt: true },
      });

      // 🔴 THE LAST SLOT TAKES THE REQUEST WITH IT (`Q-C4` ②: the request's status is DERIVED from
      // its slots). A booking with every slot cancelled but a status still reading `APPROVED` is
      // the two-sources-of-truth bug that ruling exists to forbid — and it would sit in the
      // approved accordion looking like something that is still going to happen.
      //
      // ⚠️ THAT BRANCH LEAVES THE SPAN ALONE, so a request cancelled slot by slot ends up carrying
      // the window of whichever slot went LAST rather than its original range. Measured, and
      // correct for what the column is for: the history group needs a date to sort by, and no
      // aggregate over zero live slots exists to compute a better one.
      await tx.bookingRequest.update({
        where: { id: booking.id },
        data:
          remaining.length === 0
            ? { status: BookingStatus.CANCELLED }
            : {
                firstStartAt: new Date(
                  Math.min(...remaining.map((s) => s.startAt.getTime())),
                ),
                lastEndAt: new Date(
                  Math.max(...remaining.map((s) => s.endAt.getTime())),
                ),
              },
      });
      return booking.id;
    });

    return this.readDetail({ id });
  }

  /** The detail read, shared by the GET and by both cancel routes' echo of the new state. */
  private async readDetail(
    where: Prisma.BookingRequestWhereInput,
  ): Promise<BookingDetailResponseDto> {
    const [row, leadMinutes] = await Promise.all([
      this.prisma.bookingRequest.findFirst({ where, include: DETAIL_INCLUDE }),
      this.cancelLeadMinutes(),
    ]);
    if (!row) throw new NotFoundException(BOOKING_NOT_FOUND);
    return toDetailDto(row, leadMinutes);
  }

  /**
   * `booking.cancel_lead_minutes`, or the documented default (`Q-C4` ①).
   *
   * ⚠️ A MISSING OR MALFORMED ROW FALLS BACK RATHER THAN THROWING. The seed writes it and a migrated
   * database always has it, but the failure mode of being wrong here is "nobody in the product can
   * cancel anything", and that must not be one bad row away. `value` is a `String` column because
   * `app_settings` is one table for every setting — parsing it is this reader's job.
   */
  private async cancelLeadMinutes(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({
      where: { key: CANCEL_LEAD_MINUTES_KEY },
      select: { value: true },
    });
    const parsed = Number.parseInt(row?.value ?? '', 10);
    // `>= 0` and not `> 0`: zero is a legitimate configuration meaning "cancel right up to the
    // start". Negative would mean "cancel after it began", which is not a policy, it is a typo.
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : CANCEL_LEAD_MINUTES_DEFAULT;
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
    slots: row.slots.map(toSlotDto),
    createdAt: row.createdAt,
  };
}

/**
 * A booking addressed by cuid **or** by `code`, scoped to its owner.
 *
 * 🔴 THE OWNERSHIP IS INSIDE THE `where`, WHICH IS WHY THE ANSWER IS 404 AND NOT 403. A 403 would
 * confirm the row exists, and `code` is a guessable label — `BR-` plus a date plus a three-digit
 * counter — so the oracle would be walkable by hand rather than needing a cuid. Every route that
 * reaches a booking goes through this function; there is no second way to name one.
 *
 * ⚠️ THE LEADING `#` IS STRIPPED. Users paste `#BR-25690903-001` because that is how the number is
 * written to them in LINE, and a URL or a search that refused the exact string it displayed would
 * be the product being wrong about its own identifier.
 */
function ownedBookingWhere(
  idOrCode: string,
  lineUserId: string,
): Prisma.BookingRequestWhereInput {
  const key = idOrCode.trim().replace(/^#/, '');
  return { lineUserId, OR: [{ id: key }, { code: key }] };
}

/**
 * `q` → the four columns the prototype searches (`mbMatch`): the booking number, the purpose, and
 * the venue's name and location.
 *
 * ⚠️ AN EMPTY TERM MUST PRODUCE NO CLAUSE AT ALL, not `contains: ''`. Postgres matches every row on
 * an empty substring, so the two happen to agree today — but `q=` would then be silently relying on
 * that, and the day a `NULL` location or a stricter matcher arrives it stops being true.
 */
function searchWhere(q?: string): Prisma.BookingRequestWhereInput {
  const term = q?.trim().replace(/^#/, '') ?? '';
  if (!term) return {};
  const like = { contains: term, mode: 'insensitive' } as const;
  return {
    OR: [
      { code: like },
      { purpose: like },
      { venue: { name: like } },
      { venue: { location: like } },
    ],
  };
}

/**
 * The four columns a cancellation writes, together.
 *
 * 🔴 `isCancelled` AND `cancelledAt` ARE A PAIR (`schema.prisma`): the flag is what the overlap
 * index covers, the timestamp is what the audit reads, and one without the other is a corrupt row.
 * They are written from one helper so no path can set half of it.
 *
 * ⚠️ `cancelledByRole` IS NOT A FOREIGN KEY. `cancelledById` may point into `line_users` or into
 * `system_users` — two tables with no bridge — and this string is the only thing that says which.
 */
function cancellation(
  at: Date,
  lineUserId: string,
): Prisma.BookingSlotUpdateManyMutationInput {
  return {
    isCancelled: true,
    cancelledAt: at,
    cancelledById: lineUserId,
    cancelledByRole: CANCELLED_BY_LINE_USER,
  };
}

/**
 * The tombstone category, derived exactly as `/venue-types` derives it — **flag AND name, never the
 * name alone**. An operator may create an ordinary category literally called `ไม่พบประเภทสถานที่`,
 * and that row must render as the ordinary category it is.
 */
function toVenueTypeDto(type: {
  id: number;
  name: string;
  isSystemReserved: boolean;
}) {
  return {
    id: type.id,
    name: type.name,
    isFallback:
      type.isSystemReserved && type.name === TOMBSTONE_VENUE_TYPE_NAME,
  };
}

function toSlotDto(slot: {
  id: string;
  startAt: Date;
  endAt: Date;
  isCancelled: boolean;
  cancelledAt: Date | null;
  cancelReason: string | null;
}): BookingSlotResponseDto {
  return {
    id: slot.id,
    startAt: slot.startAt,
    endAt: slot.endAt,
    isCancelled: slot.isCancelled,
    cancelledAt: slot.cancelledAt,
    cancelReason: slot.cancelReason,
  };
}

function toListDto(row: ListRow): BookingListItemDto {
  return {
    id: row.id,
    code: row.code,
    venue: {
      id: row.venue.id,
      name: row.venue.name,
      location: row.venue.location,
      venueType: toVenueTypeDto(row.venue.venueType),
      photos: row.venue.photos,
    },
    purpose: row.purpose,
    attendees: row.attendees,
    status: row.status,
    rejectReason: row.rejectReason,
    firstStartAt: row.firstStartAt,
    lastEndAt: row.lastEndAt,
    slots: row.slots.map(toSlotDto),
    createdAt: row.createdAt,
  };
}

/**
 * ⚠️ `approvedById` IS READ AND NOT RETURNED — see {@link BookingDetailResponseDto}. A LINE user is
 * entitled to know their request was ruled on and when; they are not entitled to a named staff
 * member. It is not selected at all, so it cannot leak through a later spread.
 */
function toDetailDto(
  row: DetailRow,
  cancelLeadMinutes: number,
): BookingDetailResponseDto {
  return {
    id: row.id,
    code: row.code,
    venue: {
      id: row.venue.id,
      name: row.venue.name,
      location: row.venue.location,
      capacity: row.venue.capacity,
      isOpen: row.venue.isOpen,
      venueType: toVenueTypeDto(row.venue.venueType),
      photos: row.venue.photos,
      amenities: row.venue.amenities.map((a) => a.amenity),
    },
    purpose: row.purpose,
    attendees: row.attendees,
    status: row.status,
    rejectReason: row.rejectReason,
    firstStartAt: row.firstStartAt,
    lastEndAt: row.lastEndAt,
    approvedAt: row.approvedAt,
    slots: row.slots.map(toSlotDto),
    cancelLeadMinutes,
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
