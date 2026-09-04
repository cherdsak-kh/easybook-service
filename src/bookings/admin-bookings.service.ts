import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppAccess, BookingStatus, Prisma, SystemRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isCodeCollision, nextBookingCode } from './booking-code';
import {
  approvedClashWhere,
  assertNoApprovedClash,
  findPendingLosers,
  isOverlapViolation,
  isTransactionRace,
  parseSlots,
  type SlotSpan,
} from './booking-overlap';
import {
  AUTO_REJECTED_REASON,
  BOOKING_ALREADY_CANCELLED,
  BOOKING_CODE_MAX_ATTEMPTS,
  BOOKING_DECISION_RACE,
  BOOKING_NOT_APPROVED_FOR_CANCEL,
  BOOKING_NOT_FOUND,
  BOOKING_NOT_PENDING_FOR_DECISION,
  BOOKING_VENUE_LOCK_NS,
  INVALID_DEPARTMENT,
  INVALID_LINE_USER,
  SLOT_ALREADY_CANCELLED,
  SLOT_NOT_ON_THIS_BOOKING,
  SLOT_TAKEN,
  VENUE_NOT_FOUND,
} from './bookings.constants';
import type {
  AdminBookingRequestDetailDto,
  AdminBookingRequesterDto,
  AdminBookingRequestListItemDto,
  AdminBookingSlotDto,
  ApproveBookingResponseDto,
  AutoRejectedBookingDto,
  BookingConflictsDto,
  BookingPreflightResponseDto,
  BookingStatusCountsDto,
  PaginatedBookingRequestsResponseDto,
} from './dto/admin-booking-response.dto';
import type {
  BookingPreflightDto,
  CancelBookingRequestDto,
  CreateDirectBookingDto,
  RejectBookingRequestDto,
} from './dto/admin-booking-write.dto';
import {
  type BookingRequestSort,
  type ListBookingRequestsQueryDto,
} from './dto/list-booking-requests-query.dto';

/** The actor, narrowed to the two facts every write on this surface records. */
type Actor = { id: string; role: SystemRole };

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
const REQUESTER_SELECT = {
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

const LIST_SELECT = {
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
  ...REQUESTER_SELECT,
  venue: { select: { id: true, name: true, location: true } },
  slots: { ...ADMIN_SLOTS, select: SLOT_SELECT },
} satisfies Prisma.BookingRequestSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  venueId: true,
  approvedAt: true,
  venue: {
    select: {
      id: true,
      name: true,
      location: true,
      capacity: true,
      isOpen: true,
    },
  },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  approvedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.BookingRequestSelect;

type ListRow = Prisma.BookingRequestGetPayload<{ select: typeof LIST_SELECT }>;
type DetailRow = Prisma.BookingRequestGetPayload<{
  select: typeof DETAIL_SELECT;
}>;

/**
 * ⚠️ EVERY ORDERING ENDS IN `code: 'asc'`, which makes it TOTAL. Two requests submitted in the same
 * second are otherwise ordered by whatever Postgres feels like, so page 2 could repeat a row page 1
 * already showed — and a queue that loses a request between two reads is worse than a slow one.
 *
 * ⚠️ `event-*` ORDERS ON `firstStartAt` — an indexed scalar, NOT an aggregate, NOT a subquery, and
 * NOT `slots[0]` (AC-BR4). The denormalised pair exists precisely so this is a plain column sort.
 */
const SORT_ORDER: Record<
  BookingRequestSort,
  Prisma.BookingRequestOrderByWithRelationInput[]
> = {
  'created-desc': [{ createdAt: 'desc' }, { code: 'asc' }],
  'created-asc': [{ createdAt: 'asc' }, { code: 'asc' }],
  'event-asc': [{ firstStartAt: 'asc' }, { code: 'asc' }],
  'event-desc': [{ firstStartAt: 'desc' }, { code: 'asc' }],
};

/**
 * `ADMIN-BOOKING-1` — the staff half of the booking domain (`SessionGuard` + `RolesGuard`).
 *
 * ── WHY THIS IS A SECOND SERVICE AND NOT MORE METHODS ON `BookingsService` ──
 * That file implements the LIFF lifecycle, is past 900 lines, and its spec must stay green WITHOUT
 * being edited (plan §5). The two share exactly what they should: the overlap predicate
 * (`booking-overlap.ts`) and the code minting (`booking-code.ts`), both extracted rather than copied.
 *
 * ── 🔴 ADR-001, AND WHERE IT IS ACTUALLY ENFORCED ──
 * THREE layers, and each does a different job — collapsing any two is the mistake to avoid:
 *
 *   1. `pg_advisory_xact_lock(NS, hashtext(venueId))`, the FIRST statement of every deciding
 *      transaction. It serialises decisions per venue so the refusal is POLITE. Without it, two
 *      simultaneous approvals of overlapping requests DEADLOCK rather than one losing — each holds
 *      its own request's row and needs the other's to reject it.
 *   2. `assertNoApprovedClash`, inside the transaction, after the lock. It turns "the room is taken"
 *      into a `409` with a sentence, and it is what AC-BR17 measures.
 *   3. `booking_slots_no_overlap`, the partial GiST exclusion constraint. It makes the refusal
 *      CERTAIN. Whoever writes the next route and forgets 1 and 2 still cannot double-book — they
 *      just get a raw `23P01`, which {@link isOverlapViolation} converts into the same `409`.
 *
 * ⚠️ ISOLATION LEVEL IS `READ COMMITTED`, Prisma's and Postgres's default, RECORDED HERE ON PURPOSE
 * (plan R6). `Serializable` is not used: the correctness boundary is an index-level constraint that
 * does not care about isolation, so it would buy nothing and hand every approval a `40001` to retry.
 */
@Injectable()
export class AdminBookingsService {
  private readonly logger = new Logger(AdminBookingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /booking-requests` — the queue.
   *
   * ⚠️ FILTERED, SORTED **AND** PAGINATED BY THE SERVER (AC-BR2). Nothing here streams the table to
   * the browser to be narrowed there.
   *
   * ── A LIMITATION MEASURED AND ACCEPTED, NOT MISSED ──
   * The README asks for requests with no live slots left to "sort last". They do not: a fully
   * cancelled request KEEPS the span it last had (`cancelApprovedSlot` explains why — the history
   * group still needs a date to sort by, and no aggregate over zero live slots exists), so it sorts
   * among its original dates. Pushing it last would need a first-level sort on `status`, which
   * Prisma's `orderBy` cannot express in the required order; the alternatives — sorting in memory or
   * concatenating two queries — both break AC-BR2's server-side rule. It is accepted because a
   * fully cancelled request has its OWN `ยกเลิก` tab, and neither `รอพิจารณา` (the opening view) nor
   * `อนุมัติแล้ว` can contain one. The case only arises on `ทั้งหมด`, which is not a deciding view.
   */
  async list(
    query: ListBookingRequestsQueryDto,
  ): Promise<PaginatedBookingRequestsResponseDto> {
    // The filter WITHOUT `status`, because the tab counts must not be narrowed by the selected tab.
    const baseWhere: Prisma.BookingRequestWhereInput = {
      ...(query.venueId ? { venueId: query.venueId } : {}),
      ...searchWhere(query.search),
    };
    const where: Prisma.BookingRequestWhereInput = {
      ...baseWhere,
      ...(query.status ? { status: query.status } : {}),
    };
    const skip = (query.page - 1) * query.limit;

    const [rows, total, grouped] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where,
        select: LIST_SELECT,
        orderBy: SORT_ORDER[query.sort],
        skip,
        take: query.limit,
      }),
      this.prisma.bookingRequest.count({ where }),
      // ONE grouped query for all five numbers rather than five counts — and the reason it is not
      // `_count: true` per status in a loop is that a loop would be five round trips for a tab strip.
      this.prisma.bookingRequest.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const now = new Date();
    return {
      data: rows.map((row) => toListDto(row, now)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      counts: toCounts(grouped),
    };
  }

  /**
   * `GET /booking-requests/:id` — cuid only.
   *
   * ⚠️ NO `code` LOOKUP HERE, unlike the LIFF detail. That route accepts both because the
   * confirmation screen only ever knew the `BR-…` number it just printed; this one is opened from a
   * row that already carries the id, so a second key would be a second thing to keep working with no
   * caller.
   */
  async getDetail(id: string): Promise<AdminBookingRequestDetailDto> {
    return this.readDetail(this.prisma, id);
  }

  /**
   * `POST /booking-requests/:id/approve` — ADR-001's main path.
   *
   * THE ORDER OF THE EIGHT STEPS IS THE DESIGN, not an implementation detail. Each is numbered below
   * with what breaks if it moves.
   */
  async approve(id: string, actor: Actor): Promise<ApproveBookingResponseDto> {
    const { bookingId, autoRejected } = await this.runDecision(async (tx) => {
      // 1. Cheapest question first, and the one that decides between 404 and everything else.
      const booking = await tx.bookingRequest.findUnique({
        where: { id },
        select: { id: true, venueId: true, status: true },
      });
      if (!booking) throw new NotFoundException(BOOKING_NOT_FOUND);

      // 0. THE LOCK, BEFORE EVERY READ THAT FEEDS THE DECISION. Taken after the existence read
      //    only because that read needs the `venueId` to lock on and cannot itself be raced into
      //    wrongness — nothing in this product changes a request's venue ("A request never changes
      //    venue", `schema.prisma`). Everything that DOES decide is re-read below, under the lock.
      await lockVenue(tx, booking.venueId);

      // 2. State machine. Never a silent overwrite of somebody else's decision.
      const current = await tx.bookingRequest.findUnique({
        where: { id },
        select: { status: true },
      });
      if (current?.status !== BookingStatus.PENDING) {
        throw new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION);
      }

      // 3. There has to be something to approve — and these spans are the input to steps 4 and 5.
      const live = await tx.bookingSlot.findMany({
        where: { bookingRequestId: id, isCancelled: false },
        select: { startAt: true, endAt: true },
      });
      if (live.length === 0) {
        throw new ConflictException(BOOKING_ALREADY_CANCELLED);
      }
      const spans: SlotSpan[] = live.map((s) => ({
        start: s.startAt,
        end: s.endAt,
      }));

      // 4. THE HARD BLOCK (AC-BR17). Before step 5, because if the room is already taken this
      //    approval does not happen — so there are no losers to speak of, and nobody is rejected.
      await assertNoApprovedClash(tx, booking.venueId, spans, {
        excludeRequestId: id,
      });

      // 5. 🔴 THE LOSERS, COLLECTED IN FULL *BEFORE* THIS REQUEST'S OWN STATUS FLIPS (AC-BR14).
      //    Read after the flip, the set reported to the screen would be a different set from the one
      //    written. Read once, write once.
      const losers = await findPendingLosers(tx, booking.venueId, spans, {
        excludeRequestId: id,
      });

      // 6. CONDITIONAL `updateMany`, NOT `update` — Postgres arbitrates the state machine, exactly
      //    as `cancelPendingBooking` does, because a double-tap on a phone is the ordinary case.
      //    ⚠️ THIS is the statement the parent trigger fires on, and therefore where `23P01` appears.
      const flipped = await tx.bookingRequest.updateMany({
        where: { id, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.APPROVED,
          approvedById: actor.id,
          approvedAt: new Date(),
        },
      });
      if (flipped.count !== 1) {
        throw new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION);
      }

      // 7. AFTER step 6: if the approval failed, nobody may have been rejected for it. `status:
      //    PENDING` in the `where` means a request somebody else ruled on meanwhile is left alone.
      const rejected = await this.rejectLosers(tx, losers);

      // ⛔ NOTHING TOUCHES THE LOSERS' SLOTS, and nothing recomputes any `firstStartAt`/`lastEndAt`.
      //    A rejected request still owns its rows; they stop occupying the calendar because the
      //    filter is on the PARENT's status. `approve`/`reject` add, remove and cancel no slot, so
      //    the writer's contract does not apply to them.
      return { bookingId: id, autoRejected: rejected };
    });

    // 8. Read the settled state back, outside the transaction.
    return {
      booking: await this.readDetail(this.prisma, bookingId),
      autoRejected,
    };
  }

  /**
   * `POST /booking-requests/:id/reject`.
   *
   * ⚠️ NO ADVISORY LOCK, AND NO SLOT WRITE. Rejecting frees nothing and occupies nothing, so it does
   * not touch the venue's calendar and has nothing to serialise against.
   *
   * ⛔ IT MUST NOT SET `isCancelled` ON THE SLOTS. "This request was refused" and "this span was
   * cancelled" are different facts; conflating them produces rows with `isCancelled = true` and a
   * null `cancelledAt`, which the schema's writer's contract calls corrupt. A rejected request stops
   * occupying the calendar because the filter reads the PARENT's status.
   */
  async reject(
    id: string,
    dto: RejectBookingRequestDto,
    actor: Actor,
  ): Promise<AdminBookingRequestDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const booking = await tx.bookingRequest.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!booking) throw new NotFoundException(BOOKING_NOT_FOUND);
      if (booking.status !== BookingStatus.PENDING) {
        // Includes APPROVED on purpose: the way back from an approval is `cancel`, not `reject`.
        throw new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION);
      }

      const flipped = await tx.bookingRequest.updateMany({
        where: { id, status: BookingStatus.PENDING },
        data: { status: BookingStatus.REJECTED, rejectReason: dto.reason },
      });
      if (flipped.count !== 1) {
        throw new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION);
      }
    });

    // id only — `purpose`, `reason`, the requester's name and their phone are PII (PDPA).
    this.logger.log(`Booking rejected id=${id} by=${actor.id}`);
    return this.readDetail(this.prisma, id);
  }

  /**
   * `POST /booking-requests/:id/cancel` — the whole booking, or named slots.
   *
   * ── 🔴 THREE THINGS THIS DOES NOT COPY FROM `cancelApprovedSlot`, AND WHY ──
   * 1. **No `booking.cancel_lead_minutes` check.** That setting is `Q-C4` ①'s rule about how late an
   *    END USER may cancel their own booking. A caretaker cancelling this afternoon's event because
   *    a pipe burst is the reason this screen exists — copying the check would make it permanently
   *    impossible for staff to cancel anything happening today, and it would fail with a `422` that
   *    reads like a bug.
   * 2. **`APPROVED` only.** A `PENDING` request is refused with `reject`. Accepting it here would be
   *    a second road to `CANCELLED` that no button drives.
   * 3. **The actor is a `SystemUser`.** `cancelledById` is their id and `cancelledByRole` their real
   *    `SystemRole` — `SUPER_ADMIN` or `ADMIN`, since `@Roles` admits nobody else.
   */
  async cancel(
    id: string,
    dto: CancelBookingRequestDto,
    actor: Actor,
  ): Promise<AdminBookingRequestDetailDto> {
    await this.runDecision(async (tx) => {
      const booking = await tx.bookingRequest.findUnique({
        where: { id },
        select: { id: true, venueId: true, status: true },
      });
      if (!booking) throw new NotFoundException(BOOKING_NOT_FOUND);

      await lockVenue(tx, booking.venueId);

      const current = await tx.bookingRequest.findUnique({
        where: { id },
        select: { status: true },
      });
      if (current?.status !== BookingStatus.APPROVED) {
        throw new ConflictException(BOOKING_NOT_APPROVED_FOR_CANCEL);
      }

      // EVERY slot, cancelled ones included — ownership of an id has to be checked against the whole
      // set, or "already cancelled" would be indistinguishable from "not on this booking".
      const all = await tx.bookingSlot.findMany({
        where: { bookingRequestId: id },
        select: {
          id: true,
          startAt: true,
          endAt: true,
          isCancelled: true,
        },
      });
      const live = all.filter((s) => !s.isCancelled);
      if (live.length === 0) {
        throw new ConflictException(BOOKING_ALREADY_CANCELLED);
      }

      let targets = live;
      if (dto.slotIds) {
        const byId = new Map(all.map((s) => [s.id, s]));
        for (const slotId of dto.slotIds) {
          const slot = byId.get(slotId);
          // 🔴 REFUSED, NEVER SKIPPED (AC-BR9). Three ids in and one cancellation out, reported as
          // success, is worse than any error: two days stay booked that the operator believes are
          // gone.
          if (!slot) throw new BadRequestException(SLOT_NOT_ON_THIS_BOOKING);
          if (slot.isCancelled) {
            throw new ConflictException(SLOT_ALREADY_CANCELLED);
          }
        }
        const wanted = new Set(dto.slotIds);
        targets = live.filter((s) => wanted.has(s.id));
      }

      const targetIds = targets.map((s) => s.id);
      const cancelled = await tx.bookingSlot.updateMany({
        where: { id: { in: targetIds }, isCancelled: false },
        // The five columns of a cancellation, written TOGETHER by one helper so no path can write
        // half of it (`schema.prisma`'s writer's contract; half of AC-BR10).
        // ← the BEFORE UPDATE trigger clears `holdsSlot`, so the span leaves the index and the room
        //   is free on the very next read. No job, no cache, nothing to invalidate.
        data: staffCancellation(new Date(), actor, dto.reason),
      });
      if (cancelled.count !== targetIds.length) {
        throw new ConflictException(SLOT_ALREADY_CANCELLED);
      }

      // 🔴 `cancel` IS A WRITER of the denormalised span, so it MUST recompute it in this same
      // transaction (AC-BR10). `approve` and `reject` are not, and must not.
      const remaining = live.filter((s) => !targetIds.includes(s.id));
      await tx.bookingRequest.update({
        where: { id },
        data:
          remaining.length === 0
            ? // ⚠️ THE SPAN IS LEFT ALONE when nothing survives — the one exception, and it already
              // exists in `cancelApprovedSlot`: the history group needs a date to sort by, `min()`
              // over an empty set has no honest answer, and both columns are NOT NULL.
              { status: BookingStatus.CANCELLED }
            : {
                firstStartAt: new Date(
                  Math.min(...remaining.map((s) => s.startAt.getTime())),
                ),
                lastEndAt: new Date(
                  Math.max(...remaining.map((s) => s.endAt.getTime())),
                ),
              },
      });
      return { bookingId: id, autoRejected: [] };
    });

    this.logger.log(
      `Booking slots cancelled id=${id} slots=${dto.slotIds?.length ?? 'all'} by=${actor.id}`,
    );
    return this.readDetail(this.prisma, id);
  }

  /**
   * `POST /booking-requests/direct` — staff lock a room outright (`D-C18`).
   *
   * ⚠️ THE CODE RETRY WRAPS THE WHOLE TRANSACTION, not the create. A `P2002` aborts the transaction,
   * so the next attempt must be a new one — and it recounts, which is the point: it now sees the row
   * that beat it. Identical to `BookingsService.insertWithCode`.
   */
  async createDirect(
    dto: CreateDirectBookingDto,
    actor: Actor,
  ): Promise<ApproveBookingResponseDto> {
    assertOriginShape(dto);
    const spans = parseSlots(dto.slots);

    for (let attempt = 1; attempt <= BOOKING_CODE_MAX_ATTEMPTS; attempt++) {
      try {
        const { bookingId, autoRejected } = await this.runDecision((tx) =>
          this.createDirectOnce(tx, dto, spans, actor),
        );
        return {
          booking: await this.readDetail(this.prisma, bookingId),
          autoRejected,
        };
      } catch (err) {
        if (!isCodeCollision(err) || attempt === BOOKING_CODE_MAX_ATTEMPTS) {
          throw err;
        }
        // id only — `purpose`, `requesterName` and `contactPhone` are PII and are never logged.
        this.logger.warn(
          `Booking code collision on venue=${dto.venueId}; retrying (attempt ${attempt}).`,
        );
      }
    }
    // Unreachable: the loop either returns or rethrows on its last attempt.
    throw new InternalServerErrorException();
  }

  private async createDirectOnce(
    tx: Prisma.TransactionClient,
    dto: CreateDirectBookingDto,
    spans: SlotSpan[],
    actor: Actor,
  ): Promise<{ bookingId: string; autoRejected: AutoRejectedBookingDto[] }> {
    // 0. The lock comes first here — unlike `approve`, the venue is known from the body, so there is
    //    nothing to read before taking it.
    await lockVenue(tx, dto.venueId);

    // 2. 🟡 `isOpen` IS DELIBERATELY NOT CHECKED. `venues.constants` defines a closed venue as one
    //    that "stays VISIBLE and refuses NEW booking REQUESTS" — and a staff lock is not a request.
    //    A room closed for repairs is exactly a room staff need to be able to block out themselves.
    //    The response carries `venue.isOpen`, so the screen can warn. (Design §C.6 ① / G2 — if the
    //    PO reverses this, it is one `if` here.)
    const venue = await tx.venue.findFirst({
      where: { id: dto.venueId, deletedAt: null },
      select: { id: true },
    });
    if (!venue) throw new NotFoundException(VENUE_NOT_FOUND);

    // 3. The two FK inputs, validated INSIDE the transaction against the ACTIVE row — the FK itself
    //    cannot do this, because `onDelete: Restrict` guards hard deletes and a soft-deleted row
    //    still physically exists (`CLAUDE.md`).
    if (dto.lineUserId) {
      const lineUser = await tx.lineUser.findFirst({
        where: {
          id: dto.lineUserId,
          deletedAt: null,
          access: AppAccess.ALLOWED,
        },
        select: { id: true },
      });
      if (!lineUser) throw new BadRequestException(INVALID_LINE_USER);
    }
    if (dto.departmentId !== undefined) {
      const department = await tx.department.findFirst({
        where: { id: dto.departmentId, deletedAt: null },
        select: { id: true },
      });
      if (!department) throw new BadRequestException(INVALID_DEPARTMENT);
    }

    // 4. The hard block. No `excludeRequestId` — this request does not exist yet.
    await assertNoApprovedClash(tx, venue.id, spans);

    // 5. 🔴 The losers, before the INSERT, for the same reason as in `approve` (AC-BR16: a direct
    //    booking takes the room from competing requests exactly as an approval does).
    const losers = await findPendingLosers(tx, venue.id, spans);

    const now = new Date();
    const code = await nextBookingCode(tx, now);
    // 6. ⚠️ THE SPAN IS COMPUTED IN THE SAME STATEMENT AS THE SLOTS IT SUMMARISES, so the cache
    //    cannot be written without its source. ← the BEFORE INSERT trigger sets `holdsSlot` on each
    //    child, which is where `23P01` surfaces on this path.
    const created = await tx.bookingRequest.create({
      data: {
        code,
        venueId: venue.id,
        // Both origin columns may be set at once — staff booking ON BEHALF OF a LINE user. The
        // `booking_requests_owner_check` CHECK is satisfied by `createdById` either way.
        createdById: actor.id,
        lineUserId: dto.lineUserId ?? null,
        requesterName: dto.requesterName ?? null,
        contactPhone: dto.contactPhone ?? null,
        departmentId: dto.departmentId ?? null,
        purpose: dto.purpose,
        attendees: dto.attendees,
        // 🔴 CREATION *IS* THE APPROVAL (`D-C18`, AC-BR11) — `approvedById` is the caller, the same
        // person as `createdById`, and the two columns still mean different things: who typed it and
        // who allowed it.
        status: BookingStatus.APPROVED,
        approvedById: actor.id,
        approvedAt: now,
        firstStartAt: new Date(
          Math.min(...spans.map((s) => s.start.getTime())),
        ),
        lastEndAt: new Date(Math.max(...spans.map((s) => s.end.getTime()))),
        slots: {
          // `venueId` repeated onto every child on purpose: the schema's writer's contract is that
          // `BookingSlot.venueId === BookingRequest.venueId`, nothing in Prisma enforces it, and
          // this is the single statement allowed to write both from one value (AC-BR11).
          create: spans.map((s) => ({
            venueId: venue.id,
            startAt: s.start,
            endAt: s.end,
          })),
        },
      },
      select: { id: true },
    });

    // 7. Same as `approve` step 7.
    const autoRejected = await this.rejectLosers(tx, losers);
    return { bookingId: created.id, autoRejected };
  }

  /**
   * ADR-001's write half: one `updateMany`, one `rejectReason`, no slot touched.
   *
   * ⚠️ `status: PENDING` STAYS IN THE `where` so a request somebody else ruled on in the meantime is
   * not overwritten. The returned list is the set that was *asked* for; a row that slipped away is
   * reported as auto-rejected only if it was still `PENDING` — which is why the count is checked
   * against the ids rather than assumed.
   */
  private async rejectLosers(
    tx: Prisma.TransactionClient,
    losers: { id: string; code: string }[],
  ): Promise<AutoRejectedBookingDto[]> {
    if (losers.length === 0) return [];
    await tx.bookingRequest.updateMany({
      where: {
        id: { in: losers.map((l) => l.id) },
        status: BookingStatus.PENDING,
      },
      data: {
        status: BookingStatus.REJECTED,
        // 🔴 NAMES NOBODY (AC-BR15). Its reader is the LOSER, a different end-user from the winner,
        // and they are not entitled to know who took the room or what for.
        rejectReason: AUTO_REJECTED_REASON,
      },
    });
    return losers.map((l) => ({ id: l.id, code: l.code }));
  }

  /**
   * The transaction wrapper every deciding path shares.
   *
   * 🔴 THE THREE SQLSTATE TRANSLATIONS LIVE HERE AND NOWHERE ELSE (AC-BR22). `23P01` has no Prisma
   * error code at all, so an untranslated one is a `500` — the exact failure AC-BR22 forbids.
   * `HttpException`s raised deliberately inside the callback pass through untouched: throwing is
   * what rolls the transaction back, so the status and the rollback are one event (AC-BR17).
   */
  private async runDecision(
    work: (
      tx: Prisma.TransactionClient,
    ) => Promise<{ bookingId: string; autoRejected: AutoRejectedBookingDto[] }>,
  ): Promise<{ bookingId: string; autoRejected: AutoRejectedBookingDto[] }> {
    try {
      return await this.prisma.$transaction(work);
    } catch (err) {
      // `P2002` on `code` must reach `createDirect`'s retry loop untouched — it is a different
      // failure with a different answer, and swallowing it here as a 409 would break the retry.
      if (isCodeCollision(err)) throw err;
      if (isOverlapViolation(err)) throw new ConflictException(SLOT_TAKEN);
      if (isTransactionRace(err)) {
        throw new ConflictException(BOOKING_DECISION_RACE);
      }
      throw err;
    }
  }

  /**
   * The detail read, shared by the GET and by every write's echo of the new state.
   *
   * The `conflicts` block costs two extra queries and only for a `PENDING` request — every other
   * status has nothing to decide, so it short-circuits to the empty answer without touching the DB.
   */
  private async readDetail(
    client: PrismaService,
    id: string,
  ): Promise<AdminBookingRequestDetailDto> {
    const row = await client.bookingRequest.findUnique({
      where: { id },
      select: DETAIL_SELECT,
    });
    if (!row) throw new NotFoundException(BOOKING_NOT_FOUND);
    return {
      ...toListDto(row, new Date()),
      venue: row.venue,
      createdBy: row.createdBy,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt,
      conflicts: await this.conflictsOf(client, row),
    };
  }

  private async conflictsOf(
    client: PrismaService,
    row: DetailRow,
  ): Promise<BookingConflictsDto> {
    // The two early-outs are THIS method's concern, not the shared core's: a settled request has
    // nothing to decide, and one with no live slots has nothing to ask about. Both answer without
    // touching the database.
    if (row.status !== BookingStatus.PENDING) {
      return { approvedClash: false, pendingLosers: [] };
    }
    const spans: SlotSpan[] = row.slots
      .filter((s) => !s.isCancelled)
      .map((s) => ({ start: s.startAt, end: s.endAt }));
    if (spans.length === 0) {
      return { approvedClash: false, pendingLosers: [] };
    }

    const { approvedClashCount, pending } = await this.conflictPicture(
      client,
      row.venueId,
      spans,
      { excludeRequestId: row.id },
    );
    return {
      approvedClash: approvedClashCount > 0,
      pendingLosers: pending.map((p) => ({
        id: p.id,
        code: p.code,
        requesterName: p.requesterName,
        firstStartAt: p.firstStartAt,
        lastEndAt: p.lastEndAt,
      })),
    };
  }

  /**
   * `POST /booking-requests/preflight` — the create dialog's live conflict banner (`G1`).
   *
   * ── WHY IT EXISTS AT ALL ──
   * The banner must answer two questions about spans THAT ARE NOT IN THE DATABASE YET: would they
   * clash with an APPROVED booking (a 409 on submit), and which PENDING requests would ADR-001 bump
   * (which the operator must see BEFORE committing, not afterwards in `autoRejected`).
   * `GET /line-users/venues/:id/availability` answers neither: it is behind `LineIdTokenGuard` so an
   * admin session cannot reach it, and it reports busy spans without naming the pending requests.
   *
   * 🔴 IT SHARES {@link conflictPicture} WITH `conflictsOf`, AND THAT SHARING IS THE POINT. The detail
   * dialog and the create dialog must never disagree about the same venue and the same hour — that is
   * precisely the failure `booking-overlap.ts` was extracted to prevent, one layer up.
   *
   * 🔴 IT VALIDATES THROUGH `parseSlots`, THE SAME FUNCTION `direct` USES, and it runs BEFORE the
   * venue lookup so the 400/404 precedence matches `createDirect` exactly. A preflight that accepts a
   * past, inverted or self-overlapping span and then watches the submit 400 has lied to the operator.
   *
   * 🔴 NO ADVISORY LOCK, NO `$transaction`, NO WRITE. This runs while somebody is typing; taking the
   * venue lock here would let a fast typist block every approval on that venue. Like `conflicts`, the
   * answer is ADVICE — the binding refusal is the `direct` transaction, which checks again.
   */
  async checkPreflight(
    dto: BookingPreflightDto,
  ): Promise<BookingPreflightResponseDto> {
    // Before the venue read, exactly as `createDirect` orders it: a bad span is a 400 even when the
    // venue is also unknown, so the two endpoints refuse the same body the same way.
    const spans = parseSlots(dto.slots);

    // Resolved the way every other route on this surface resolves a venue: an unknown id and a
    // soft-deleted one are the same 404.
    const venue = await this.prisma.venue.findFirst({
      where: { id: dto.venueId, deletedAt: null },
      select: { id: true, isOpen: true },
    });
    if (!venue) throw new NotFoundException(VENUE_NOT_FOUND);

    const { approvedClashCount, pending } = await this.conflictPicture(
      this.prisma,
      venue.id,
      spans,
    );
    return {
      hasApprovedClash: approvedClashCount > 0,
      approvedClashCount,
      overlappingPendingRequests: pending.map((p) => ({
        id: p.id,
        code: p.code,
        purpose: p.purpose,
        requesterName: p.requesterName,
      })),
      // ⚠️ Informational, never a refusal — `isOpen` refuses new REQUESTS and a staff lock is not a
      // request (§C.6 ①). The dialog shows the administrative-override note; the server still accepts.
      venueIsOpen: venue.isOpen,
    };
  }

  /**
   * 🔴 THE ONE CORE BEHIND BOTH `conflicts` (a SAVED request) AND `preflight` (UNSAVED spans).
   *
   * The two callers ask the identical question — "what already holds these hours at this venue, and
   * who would lose them" — about span sets of different provenance. Two copies would let the detail
   * dialog and the create dialog give different answers for the same venue and the same hour, which
   * is the failure mode `booking-overlap.ts` exists to prevent; this method is that argument applied
   * one level up, where the predicate is composed rather than expressed.
   *
   * ⚠️ `count`, NOT `findFirst`. `findApprovedClash` returns only the first hit, and the banner has a
   * number in it. THE UNIT IS SLOTS: one approved three-day booking overlapping three requested days
   * counts 3, and any caller rendering it as a booking count is wrong.
   *
   * ⚠️ THREE QUERIES, NEVER N+1: the count and the loser read in parallel, then ONE read that resolves
   * every loser's requester and purpose at once. `findPendingLosers` stays the single owner of WHICH
   * requests lose (one row per request by construction, so the list is already deduplicated);
   * resolving their details is a separate, dumb read.
   */
  private async conflictPicture(
    client: Prisma.TransactionClient,
    venueId: string,
    spans: readonly SlotSpan[],
    opts: { excludeRequestId?: string } = {},
  ): Promise<{
    approvedClashCount: number;
    pending: {
      id: string;
      code: string;
      purpose: string;
      requesterName: string | null;
      firstStartAt: Date;
      lastEndAt: Date;
    }[];
  }> {
    if (spans.length === 0) return { approvedClashCount: 0, pending: [] };

    const [approvedClashCount, losers] = await Promise.all([
      client.bookingSlot.count({
        where: approvedClashWhere(venueId, spans, opts.excludeRequestId),
      }),
      findPendingLosers(client, venueId, spans, opts),
    ]);

    const requesters = await this.requestersOf(
      client,
      losers.map((l) => l.id),
    );
    return {
      approvedClashCount,
      pending: losers.map((l) => {
        // The fallbacks never fire in practice — both reads name the same ids — but a row that
        // vanished between them must not blow up a read-only preview.
        const who = requesters.get(l.id);
        return {
          id: l.id,
          code: l.code,
          purpose: who?.purpose ?? '',
          requesterName: who?.name ?? null,
          firstStartAt: l.firstStartAt,
          lastEndAt: l.lastEndAt,
        };
      }),
    };
  }

  /**
   * Every conflicting request's requester and purpose, in ONE read.
   *
   * ⚠️ `purpose` IS RESOLVED HERE RATHER THAN WIDENING `findPendingLosers`. That function is part of
   * the single-owner overlap module and answers only "which requests lose"; what a losing request is
   * FOR is a presentation fact this surface needs and the LIFF paths do not.
   */
  private async requestersOf(
    client: Prisma.TransactionClient,
    ids: string[],
  ): Promise<Map<string, { name: string | null; purpose: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await client.bookingRequest.findMany({
      where: { id: { in: ids } },
      select: { id: true, purpose: true, ...REQUESTER_SELECT },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { name: requesterOf(r).name, purpose: r.purpose },
      ]),
    );
  }
}

/**
 * 🔴 THE FIRST STATEMENT OF EVERY DECIDING TRANSACTION. See the class note for why it exists and why
 * it is not a substitute for the constraint.
 *
 * ⚠️ `$executeRaw`, NOT `$queryRaw` — MEASURED, not preferred. `pg_advisory_xact_lock` returns
 * `void`, and Prisma 7's `$queryRaw` fails to deserialize a `void` column ("Failed to deserialize
 * column of type 'void'"). `$executeRaw` asks for a row count instead and works.
 *
 * ⚠️ The `::int4` cast is what stops Postgres inferring the placeholder's type as `text` and failing
 * to find a matching overload. An xact lock releases itself at COMMIT or ROLLBACK, so a throw inside
 * the transaction leaves nothing held.
 */
async function lockVenue(
  tx: Prisma.TransactionClient,
  venueId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOKING_VENUE_LOCK_NS}::int4, hashtext(${venueId}))`;
}

/**
 * The A/B origin rule of `D-C18`, enforced in code because no decorator can see two fields at once.
 *
 * 🔴 THE THREE OVERRIDES MUST BE NULL ON A REQUEST THAT HAS A `lineUserId`. `schema.prisma` calls
 * them "OVERRIDES, NOT A SECOND PROFILE STORE": with a LINE user attached, the name, phone and
 * department resolve through the registration, and a copy on the row would be free to disagree the
 * moment the user corrects their profile.
 */
function assertOriginShape(dto: CreateDirectBookingDto): void {
  const overrides =
    dto.requesterName !== undefined ||
    dto.contactPhone !== undefined ||
    dto.departmentId !== undefined;
  if (dto.lineUserId !== undefined && overrides) {
    throw new BadRequestException(
      'requesterName, contactPhone and departmentId are overrides for a booking with no LINE account. Do not send them together with lineUserId.',
    );
  }
  // The other half — the pair being REQUIRED on path (B) — is expressed by the DTO's `@ValidateIf`,
  // so it is a field-level 400 with the usual message shape rather than this one.
}

/** The five columns a staff cancellation writes, together. Never one without the others. */
function staffCancellation(
  at: Date,
  actor: Actor,
  reason: string,
): Prisma.BookingSlotUpdateManyMutationInput {
  return {
    isCancelled: true,
    cancelledAt: at,
    cancelledById: actor.id,
    // The actor's REAL `SystemRole` — `SUPER_ADMIN` or `ADMIN`, since `@Roles` admits nobody else.
    // (The schema's doc comment used to list a `STAFF` value that no longer exists; corrected in
    // this change, G3.)
    cancelledByRole: actor.role,
    cancelReason: reason,
  };
}

/**
 * `search` → the four things the queue searches, as ONE `OR` (AC-BR3).
 *
 * ⚠️ THE REQUESTER'S NAME HAS TWO SOURCES and both must be reachable from one box: `requesterName`
 * on a staff-created row, or the registration's first/last name on a LINE-origin one.
 *
 * ⚠️ AN EMPTY TERM PRODUCES NO CLAUSE AT ALL, never `contains: ''`. Postgres matches every row on an
 * empty substring so the two agree today — but `search=` would then be relying on that, and the day
 * a `NULL` or a stricter matcher arrives it stops being true.
 */
function searchWhere(search?: string): Prisma.BookingRequestWhereInput {
  const term = search?.trim().replace(/^#/, '') ?? '';
  if (!term) return {};
  const like = { contains: term, mode: 'insensitive' } as const;
  return {
    OR: [
      { code: like },
      { purpose: like },
      { venue: { name: like } },
      { requesterName: like },
      { lineUser: { registration: { firstName: like } } },
      { lineUser: { registration: { lastName: like } } },
    ],
  };
}

/** `groupBy` rows → the five numbers, with a `0` for every status that had none. */
function toCounts(
  grouped: { status: BookingStatus; _count: { _all: number } }[],
): BookingStatusCountsDto {
  const at = (s: BookingStatus) =>
    grouped.find((g) => g.status === s)?._count._all ?? 0;
  const pending = at(BookingStatus.PENDING);
  const approved = at(BookingStatus.APPROVED);
  const rejected = at(BookingStatus.REJECTED);
  const cancelled = at(BookingStatus.CANCELLED);
  return {
    all: pending + approved + rejected + cancelled,
    pending,
    approved,
    rejected,
    cancelled,
  };
}

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
function requesterOf(row: {
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

function toListDto(row: ListRow, now: Date): AdminBookingRequestListItemDto {
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
