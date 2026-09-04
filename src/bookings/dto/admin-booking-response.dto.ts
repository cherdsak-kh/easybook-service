import { ApiProperty } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';
import { PaginationMetaDto } from '../../system-users/dto/paginated-system-users-response.dto';

/**
 * ── 🔴 THE PRIVACY DIRECTION ON THIS SURFACE, STATED ONCE ──
 * `D-C13`'s closing rule — "an unapproved request does not reveal who asked or what for" — is about
 * the VIEWER, not about the row, and **an admin is the permitted viewer**. Every DTO here therefore
 * carries `purpose`, the requester's name, their phone and their department IN EVERY STATUS,
 * `PENDING` included.
 *
 * ⛔ DO NOT REDACT THEM HERE. `schema.prisma` says why: `purpose`/`attendees` "are not description
 * fields … a human has to CHOOSE between competing requests, and that choice cannot be made from
 * times alone". Blanking them is not caution — it is removing the only inputs the decision has.
 *
 * ⛔ The LIFF-side redaction (`toAvailabilityDto`) is a DIFFERENT rule for a DIFFERENT audience and
 * must keep working exactly as it does.
 */

/** One span of a booking, as staff read it. */
export class AdminBookingSlotDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;

  @ApiProperty({
    description:
      'Per-slot cancellation (`Q-C4`). Cancelled slots are RETURNED, never filtered out — the detail dialog has to show that Wednesday was dropped and why.',
  })
  isCancelled!: boolean;

  /**
   * ⚠️ THE FLAG AND THE TIMESTAMP ARE A PAIR (`schema.prisma`'s writer's contract). A row with
   * `isCancelled: true` and a null `cancelledAt` is corrupt, which is half of what AC-BR10 checks.
   */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason!: string | null;

  /**
   * ⚠️ NOT A FOREIGN KEY, AND IT RESOLVES NOTHING ON ITS OWN. `cancelledById` may point into
   * `line_users` OR `system_users` — two tables with no bridge — and this string is the only thing
   * that says which. Live values: `LINE_USER` | `SUPER_ADMIN` | `ADMIN`.
   *
   * ⛔ `cancelledById` ITSELF IS NOT EXPOSED. It is a raw id into one of two tables that the client
   * cannot resolve, and `schema.prisma` says outright: "Do not `include` it."
   */
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['LINE_USER', 'SUPER_ADMIN', 'ADMIN'],
    description:
      'Which domain cancelled it: `LINE_USER` for a self-service cancellation, or the staff member’s real `SystemRole`. The matching id is deliberately NOT exposed — it points into one of two unbridged tables.',
  })
  cancelledByRole!: string | null;
}

/** The venue as a queue ROW needs it. */
export class AdminBookingVenueDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'หอประชุมวารณ' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  location!: string | null;
}

/** The venue as the DETAIL dialog needs it: enough to weigh a headcount against a room. */
export class AdminBookingVenueDetailDto extends AdminBookingVenueDto {
  @ApiProperty()
  capacity!: number;

  @ApiProperty({
    description:
      'A closed venue still accepts a DIRECT booking — `isOpen` refuses new REQUESTS, and a staff lock is not a request. The screen warns; the server does not refuse.',
  })
  isOpen!: boolean;
}

/**
 * Who the booking is FOR, from whichever origin wrote the row (`D-C18`).
 *
 * ⚠️ TWO SOURCES, ONE SHAPE. A LINE-origin request resolves all three through
 * `lineUserId → LineUserRegistration`; a staff-created one reads the `requesterName` /
 * `contactPhone` / `department` overrides on the row itself. `null` is a legitimate answer.
 *
 * ⚠️ NO NESTED READ HERE CARRIES A `deletedAt` FILTER — this repo's read/write asymmetry. A LINE user
 * who has since unfollowed must still resolve as the requester of a booking that already happened.
 */
export class AdminBookingRequesterDto {
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  departmentName!: string | null;
}

/** A staff member, resolved as HISTORY — never filtered by `deletedAt` (DD-4). */
export class AdminBookingStaffDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

/** One row of the approval queue. */
export class AdminBookingRequestListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'BR-25690903-001' })
  code!: string;

  @ApiProperty({ enum: BookingStatus })
  status!: BookingStatus;

  /**
   * ⚠️ INFERRED FROM `createdById`, AND IT ANSWERS "WHO TYPED IT". Both origin columns may be set at
   * once — that is staff booking on behalf of a LINE user who does have an account — and this chip
   * correctly reads `ADMIN` in that case.
   */
  @ApiProperty({
    enum: ['LINE', 'ADMIN'],
    description:
      'Where the request came from: `LINE` when `createdById` is null, otherwise `ADMIN`. It answers "who TYPED it" — a staff booking made on behalf of a LINE user reads `ADMIN`.',
  })
  origin!: 'LINE' | 'ADMIN';

  /**
   * 🔴 COMPUTED AT READ TIME, NEVER STORED. There is no fifth `BookingStatus` and no cron that would
   * write one; "หมดอายุ" is `status = PENDING && lastEndAt < now`. It is in the payload so the client
   * does not have to compare against the browser's own clock, which can be wrong.
   */
  @ApiProperty({
    description:
      '`status === PENDING && lastEndAt < now`, evaluated by the SERVER at read time. Not a stored status and not a cron — the client should not recompute it against its own clock.',
  })
  isExpired!: boolean;

  @ApiProperty({ type: AdminBookingRequesterDto })
  requester!: AdminBookingRequesterDto;

  @ApiProperty({ type: AdminBookingVenueDto })
  venue!: AdminBookingVenueDto;

  @ApiProperty({
    description:
      'วัตถุประสงค์. Returned in EVERY status including PENDING — see the file note; this is the input the approval decision is made from.',
  })
  purpose!: string;

  @ApiProperty()
  attendees!: number;

  @ApiProperty({ format: 'date-time' })
  firstStartAt!: Date;

  @ApiProperty({ format: 'date-time' })
  lastEndAt!: Date;

  /**
   * ⚠️ EVERY SLOT, CANCELLED ONES INCLUDED, ordered `startAt ASC, id ASC`. The client folds them into
   * "10–12 ก.ย. 69 (3 วัน)" or "ไม่ต่อเนื่อง"; the server does not own presentation rules. Worst case
   * is `BOOKING_SLOTS_MAX (60) × limit (50)` = 3,000 objects, which is the accepted price of not
   * maintaining a summary column that could go stale.
   */
  @ApiProperty({ type: [AdminBookingSlotDto] })
  slots!: AdminBookingSlotDto[];

  @ApiProperty({ type: String, nullable: true })
  rejectReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

/** One competing request that an approval is about to reject. */
export class BookingConflictItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Revealed on purpose: the confirm dialog must list every request it is about to reject, with its code, requester and times. An admin is the permitted viewer.',
  })
  requesterName!: string | null;

  @ApiProperty({ format: 'date-time' })
  firstStartAt!: Date;

  @ApiProperty({ format: 'date-time' })
  lastEndAt!: Date;
}

/**
 * What approving THIS request would do — the confirm dialog's whole data source.
 *
 * 🔴 ADVICE, NOT A PROMISE. It is read outside the deciding transaction and can be stale a second
 * later. The binding refusal happens inside the approval transaction; a disabled button is not a
 * security boundary, and forcing `disabled = false` and clicking still gets refused.
 */
export class BookingConflictsDto {
  @ApiProperty({
    description:
      'True when an APPROVED, non-cancelled slot already overlaps this request — approving it would be a 409. The dialog disables its confirm button on this. ⚠️ Advisory only: the server refuses again inside the transaction.',
  })
  approvedClash!: boolean;

  @ApiProperty({
    type: [BookingConflictItemDto],
    description:
      'The PENDING requests that approving this one would auto-reject. Empty when this request is not PENDING.',
  })
  pendingLosers!: BookingConflictItemDto[];
}

/** The full booking, as the detail dialog reads it. */
export class AdminBookingRequestDetailDto extends AdminBookingRequestListItemDto {
  @ApiProperty({ type: AdminBookingVenueDetailDto })
  declare venue: AdminBookingVenueDetailDto;

  @ApiProperty({
    type: AdminBookingStaffDto,
    nullable: true,
    description: 'Who TYPED it. Null on a LINE-origin request.',
  })
  createdBy!: AdminBookingStaffDto | null;

  /**
   * ⚠️ DELIBERATELY UNLIKE THE LIFF DETAIL, which returns `approvedAt` but never names the approver.
   * A LINE end-user is entitled to know their request was ruled on; they are not entitled to a named
   * staff member. An admin is.
   */
  @ApiProperty({
    type: AdminBookingStaffDto,
    nullable: true,
    description:
      'Who RULED on it. Null until approved. Resolved as history — never filtered by `deletedAt` (DD-4). ⚠️ The LIFF detail deliberately omits this; the admin surface is the permitted viewer.',
  })
  approvedBy!: AdminBookingStaffDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  approvedAt!: Date | null;

  @ApiProperty({ type: BookingConflictsDto })
  conflicts!: BookingConflictsDto;
}

/** Per-status row counts for the queue's tab strip. */
export class BookingStatusCountsDto {
  @ApiProperty({ example: 42 })
  all!: number;

  @ApiProperty({ example: 7 })
  pending!: number;

  @ApiProperty({ example: 30 })
  approved!: number;

  @ApiProperty({ example: 3 })
  rejected!: number;

  @ApiProperty({ example: 2 })
  cancelled!: number;
}

export class PaginatedBookingRequestsResponseDto {
  @ApiProperty({ type: [AdminBookingRequestListItemDto] })
  data!: AdminBookingRequestListItemDto[];

  /**
   * ⚠️ THE EXISTING `PaginationMetaDto` IS IMPORTED, NOT REDECLARED. That file says why: the OpenAPI
   * document must carry ONE `PaginationMetaDto` schema, not a `PaginationMetaDto1` the generated
   * client would mint a second, identical type for.
   */
  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;

  /**
   * 🔴 COUNTED UNDER `search` + `venueId` BUT **NOT** UNDER `status`. Counting with the status filter
   * applied would zero the other four tabs the instant one is selected — a bug the screen has no way
   * to distinguish from real data. Statuses with no rows return `0` rather than going missing.
   */
  @ApiProperty({
    type: BookingStatusCountsDto,
    description:
      'Tab counts. Computed with `search` and `venueId` applied but WITHOUT `status` — otherwise selecting a tab would zero the other four. A status with no rows is `0`, never absent.',
  })
  counts!: BookingStatusCountsDto;
}

/**
 * The answer from both writing paths that can auto-reject (`approve` and `direct`).
 *
 * ⚠️ `autoRejected` IS WHAT HAPPENED, NOT WHAT `conflicts` PREDICTED. The two differ whenever a new
 * request arrived between opening the dialog and pressing the button, and the screen must report
 * this one.
 */
export class AutoRejectedBookingDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'BR-25690903-002' })
  code!: string;
}

/**
 * One `PENDING` request that the spans being previewed would auto-reject.
 *
 * ⚠️ IT CARRIES `purpose`, AND THAT IS NOT AN OVER-SHARE. See the file note: `D-C13`'s privacy rule
 * is about the AUDIENCE, and staff are the permitted audience — the operator is about to bump these
 * people, and "who and what for" is the whole of the judgement they are being asked to make. What
 * must stay anonymous is the `rejectReason` WRITTEN ONTO a loser, because a LINE end-user reads that.
 */
export class BookingPreflightPendingDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'BR-25690903-002' })
  code!: string;

  @ApiProperty({
    description:
      'วัตถุประสงค์ of the request that would be bumped. Shown so the operator can weigh what they are about to displace.',
  })
  purpose!: string;

  @ApiProperty({ type: String, nullable: true })
  requesterName!: string | null;
}

/**
 * `POST /booking-requests/preflight` — what would happen if these UNSAVED spans were submitted.
 *
 * 🔴 IT IS ADVICE, NOT A PROMISE, for exactly the reasons {@link BookingConflictsDto} states: it is
 * read outside any deciding transaction, with no advisory lock (taking one while an operator types
 * would let a fast typist block every approval on that venue). The binding refusal is the `direct`
 * transaction, which checks again.
 *
 * ⚠️ ITS ANSWER MUST AGREE WITH `POST /direct` FOR THE SAME SPANS, and the e2e asserts exactly that
 * pairing. A banner that disagrees with the endpoint it predicts is the only way this can fail badly.
 */
export class BookingPreflightResponseDto {
  @ApiProperty({
    description:
      'True when an APPROVED, non-cancelled slot already overlaps one of the spans — submitting them would be a 409. The create dialog disables its submit button on this.',
  })
  hasApprovedClash!: boolean;

  /**
   * ⚠️ THE UNIT IS **SLOTS**, NOT BOOKINGS. One approved three-day booking that overlaps all three
   * of the requested days counts as `3`. Rendering it as "3 conflicting bookings" would be wrong;
   * it is "3 conflicting time slots".
   */
  @ApiProperty({
    example: 2,
    description:
      'How many APPROVED, non-cancelled **SLOTS** overlap the requested spans. ⚠️ SLOTS, not bookings — one three-day booking across three requested days is 3, not 1. `0` exactly when `hasApprovedClash` is false.',
  })
  approvedClashCount!: number;

  @ApiProperty({
    type: [BookingPreflightPendingDto],
    description:
      'The PENDING requests these spans overlap — ADR-001 would auto-reject every one of them on submit, so the operator sees whom they are about to bump BEFORE committing. One entry per request however many of its slots overlap.',
  })
  overlappingPendingRequests!: BookingPreflightPendingDto[];

  /**
   * ⚠️ INFORMATIONAL, NEVER A REFUSAL. A closed venue still accepts a direct booking — `isOpen`
   * refuses new REQUESTS and a staff lock is not a request — so this exists only so the dialog can
   * show its administrative-override note.
   */
  @ApiProperty({
    description:
      '`Venue.isOpen`. Informational only: a CLOSED venue still accepts a direct booking, so the dialog shows an override note rather than blocking.',
  })
  venueIsOpen!: boolean;
}

export class ApproveBookingResponseDto {
  @ApiProperty({ type: AdminBookingRequestDetailDto })
  booking!: AdminBookingRequestDetailDto;

  @ApiProperty({
    type: [AutoRejectedBookingDto],
    description:
      'The requests actually auto-rejected inside this transaction (ADR-001). May differ from the `conflicts.pendingLosers` the dialog was showing — report THIS one. Code and id only: the screen shows a confirmation, not a second dossier on other people’s requests.',
  })
  autoRejected!: AutoRejectedBookingDto[];
}
