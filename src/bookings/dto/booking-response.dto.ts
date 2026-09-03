import { ApiProperty } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';
import {
  VenueAmenityDto,
  VenuePhotoDto,
  VenueTypeSummaryDto,
} from '../../venues/dto/venue.dto';

/**
 * One span of a request, as echoed back to its own requester.
 *
 * ⚠️ THIS IS THE OWNER'S VIEW and carries no privacy rule — the caller is looking at their own
 * booking. {@link VenueAvailabilitySlotDto} is the OTHER view of the same table and is where
 * `D-C13`'s privacy clause bites.
 */
export class BookingSlotResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;

  /**
   * ⚠️ THERE IS NO PER-SLOT `status` COLUMN, and its absence is `Q-C4` sub-ruling ②. The truth about
   * a slot is `isCancelled`; the REQUEST's status is derived from its slots rather than stored twice.
   * Storing a status at both levels without a rule about which wins is the two-sources-of-truth bug
   * `VenuePhoto` avoids by having no `isCover` flag.
   */
  @ApiProperty({
    description:
      'Per-slot cancellation (`Q-C4`). Always `false` on a freshly submitted request; a three-slot request may later have one slot cancelled and keep the other two.',
  })
  isCancelled!: boolean;

  /**
   * ⚠️ THE FLAG AND THE TIMESTAMP ARE WRITTEN TOGETHER, ALWAYS (`schema.prisma`). `isCancelled: true`
   * with a null `cancelledAt` is a corrupt row, so a client may read either one as the answer to
   * "is this cancelled" — but it should read the FLAG, because that is the one the overlap index
   * covers and the one the server filters on.
   */
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When it was cancelled. Null unless `isCancelled` is true.',
  })
  cancelledAt!: Date | null;

  /**
   * ⚠️ NOT WRITTEN BY THE CLIENT CANCEL ROUTES, and its absence there is deliberate: `Q-C4` gives a
   * LINE user an unconditional right to cancel a pending request and a lead-time-bounded right to
   * drop an approved slot, and neither is contingent on explaining themselves. The column exists for
   * the STAFF side, where a cancellation happens TO somebody and has to be accountable.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Free-text reason, written only by the staff cancellation path. Always null for a cancellation the user made themselves.',
  })
  cancelReason!: string | null;
}

/**
 * The venue as a booking CARD needs it — enough to recognise the room, not enough to re-decide on
 * it. `#/bookings` shows the cover photo, the name and the category badge.
 *
 * ⚠️ `photos` IS THE WHOLE ORDERED ARRAY, not just the cover, because `position === 0` IS the cover
 * and there is no `isCover` flag to send instead (`VenuePhoto`). A list of tens of bookings carries
 * a handful of URLs per row; a `coverUrl` string would be a second encoding of `position` and free
 * to disagree with it.
 *
 * ⚠️ THE NESTED READS CARRY NO `deletedAt` FILTER — this repo's read/write asymmetry. A booking made
 * against a venue whose category was later retired must still render its category name; filtering
 * would return `null` into a non-nullable field and 500 the list.
 */
export class BookingVenueSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'หอประชุมวารณ' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'อาคารหอประชุม ชั้น 1',
  })
  location!: string | null;

  @ApiProperty({ type: VenueTypeSummaryDto })
  venueType!: VenueTypeSummaryDto;

  @ApiProperty({
    type: [VenuePhotoDto],
    description: 'Ordered. Index 0 is the cover. Empty for a venue with none.',
  })
  photos!: VenuePhotoDto[];
}

/**
 * The venue as the DETAIL screen needs it: the summary plus what the user is checking against
 * ("does the room I was given still have a projector, and how many people does it hold").
 *
 * ⚠️ IT DOES NOT EXTEND {@link BookingVenueSummaryDto}. The two are read by different endpoints with
 * different `select`s, and a subclass would let a field added to the summary reach the list's
 * response without anyone choosing to put it there.
 */
export class BookingVenueDetailDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'หอประชุมวารณ' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'อาคารหอประชุม ชั้น 1',
  })
  location!: string | null;

  @ApiProperty({ example: 900 })
  capacity!: number;

  /**
   * ⚠️ A CLOSED VENUE DOES NOT INVALIDATE AN EXISTING BOOKING. `isOpen: false` means "accepts no NEW
   * requests"; a booking already approved against it still happens. The screen uses this to explain
   * why the "จองอีกครั้ง" affordance is unavailable, never to grey out the booking itself.
   */
  @ApiProperty({ example: true })
  isOpen!: boolean;

  @ApiProperty({ type: VenueTypeSummaryDto })
  venueType!: VenueTypeSummaryDto;

  @ApiProperty({ type: [VenuePhotoDto] })
  photos!: VenuePhotoDto[];

  @ApiProperty({ type: [VenueAmenityDto], description: 'Ordered `name ASC`.' })
  amenities!: VenueAmenityDto[];
}

/**
 * One row of `#/bookings` — the caller's own booking request.
 *
 * ── 🔴 THE STATUS ON THIS ROW IS ONE OF FOUR; THE SCREEN PAINTS SIX ──
 * `สิ้นสุดแล้ว` (a past `APPROVED`) and `หมดเวลาพิจารณา` (a past `PENDING`) are **derived at read
 * time from `status` and `lastEndAt`, and never stored** (`CHECKLIST.md`, Phase 6). That is why
 * `lastEndAt` is on this DTO even though no card prints it directly: it is the input to two of the
 * six badges. A server-side `expired` enum value would be a scheduled job's problem for a fact that
 * a subtraction answers exactly.
 *
 * ⚠️ `lastEndAt` IS THE **LATEST** SLOT'S END, not the first. A three-day repeat has not finished
 * until the third day has.
 */
export class BookingListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'BR-25690902-001' })
  code!: string;

  @ApiProperty({ type: BookingVenueSummaryDto })
  venue!: BookingVenueSummaryDto;

  @ApiProperty()
  purpose!: string;

  @ApiProperty()
  attendees!: number;

  @ApiProperty({ enum: BookingStatus })
  status!: BookingStatus;

  /**
   * ⚠️ WRITTEN ON BOTH REFUSAL PATHS — an operator's explicit reject AND the auto-rejection that
   * fires when a competing request wins the slot (`D-C13` rule 5). The second is the common one.
   * 🔴 It may say the slot went to someone else; it must NEVER say who, or what for.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it was refused. Null unless `status` is `REJECTED`.',
  })
  rejectReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  firstStartAt!: Date;

  @ApiProperty({ format: 'date-time' })
  lastEndAt!: Date;

  @ApiProperty({ type: [BookingSlotResponseDto] })
  slots!: BookingSlotResponseDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

/**
 * `GET /line-users/bookings/:id` — the caller's own booking in full.
 *
 * ⚠️ NO APPROVER IDENTITY. `approvedAt` is here and `approvedById` is not: a LINE user is entitled
 * to know their request was ruled on and when, and is not entitled to a named staff member. The
 * same asymmetry `D-C13`'s privacy clause applies in the other direction.
 */
export class BookingDetailResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'BR-25690902-001' })
  code!: string;

  @ApiProperty({ type: BookingVenueDetailDto })
  venue!: BookingVenueDetailDto;

  @ApiProperty()
  purpose!: string;

  @ApiProperty()
  attendees!: number;

  @ApiProperty({ enum: BookingStatus })
  status!: BookingStatus;

  @ApiProperty({ type: String, nullable: true })
  rejectReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  firstStartAt!: Date;

  @ApiProperty({ format: 'date-time' })
  lastEndAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the request was approved. Null while pending, and on a rejected or cancelled request.',
  })
  approvedAt!: Date | null;

  @ApiProperty({ type: [BookingSlotResponseDto] })
  slots!: BookingSlotResponseDto[];

  /**
   * 🔴 THE SETTING, SENT SO THE CLIENT CAN WORD ITS OWN SENTENCE (`Q-C4` ①). The screen needs this
   * number twice — to decide whether a slot's cancel button is offered at all, and to write
   * `ต้องยกเลิกล่วงหน้าอย่างน้อย N นาที…` with the real N in it. Sending the number instead of a
   * pre-rendered message is what keeps the Thai copy in the Thai codebase (`I18N-ERR-1`) and keeps
   * it true after an operator edits `booking.cancel_lead_minutes`.
   *
   * ⚠️ IT IS NOT THE BOUNDARY. The server refuses a late cancellation whatever the client did with
   * this value; a hidden button is UX, and UX is not an authorisation boundary.
   */
  @ApiProperty({
    example: 30,
    description:
      'Cancellation lead time in minutes, from `app_settings`. A slot may be cancelled only while it starts more than this far in the future.',
  })
  cancelLeadMinutes!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

/**
 * A booking request as its own requester sees it — the response to `POST /line-users/bookings` and
 * the payload `#/sent/:id` renders.
 *
 * `venueName` is denormalised into the response (never into the table) because the confirmation
 * screen names the room and would otherwise need a second call for one string.
 */
export class BookingRequestResponseDto {
  @ApiProperty({
    description: 'The cuid primary key — what `/booking/:id` is addressed by.',
  })
  id!: string;

  /**
   * ⚠️ THE LABEL, NOT THE KEY. `BR-25690902-001` is what a user pastes out of a LINE chat into the
   * My Bookings search box; `id` is what URLs and foreign keys use. The client strips a leading `#`
   * before comparing, because people paste `#BR-…`.
   */
  @ApiProperty({
    example: 'BR-25690902-001',
    description:
      'Human-readable booking number: `BR-` + the Buddhist-era Bangkok date + a per-day sequence. Unique, and quotable over the phone.',
  })
  code!: string;

  @ApiProperty()
  venueId!: string;

  @ApiProperty({
    description:
      'Convenience copy for the confirmation screen. Not a stored column.',
  })
  venueName!: string;

  @ApiProperty()
  purpose!: string;

  @ApiProperty()
  attendees!: number;

  /**
   * 🔴 ALWAYS `PENDING` ON THIS ROUTE (`D-C13` rule 1) — a client booking is a REQUEST, never an
   * instant reservation, and a pending request holds nothing (rule 4). The field is typed as the
   * full enum because the same DTO will serve the read routes in Phase 6.
   */
  @ApiProperty({ enum: BookingStatus, example: BookingStatus.PENDING })
  status!: BookingStatus;

  /**
   * ⚠️ DENORMALISED FROM THE SLOTS, recomputed inside the same transaction as any write that adds,
   * removes or cancels one. They exist because My Bookings sorts by "soonest" and the approval queue
   * filters by "not yet past", and cursor pagination in this repo may not order through a relation.
   */
  @ApiProperty({
    format: 'date-time',
    description: 'Earliest `startAt` across the slots.',
  })
  firstStartAt!: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'Latest `endAt` across the slots.',
  })
  lastEndAt!: Date;

  @ApiProperty({ type: [BookingSlotResponseDto] })
  slots!: BookingSlotResponseDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

/**
 * ── 🔴 THE PRIVACY BOUNDARY OF THE WHOLE BOOKING DOMAIN ──
 * One occupied span on a venue's calendar, as seen by SOMEBODY ELSE.
 *
 * `D-C13`'s last clause: *an unapproved request never reveals who requested it or what for*. This
 * DTO is where that is enforced, and it is enforced by the SERVER omitting the strings — not by a
 * client choosing not to render them, which is not a privacy boundary
 * ([`TRANSPORT.md`](TRANSPORT.md) §2.3).
 *
 * Three cases, and the third is why `purpose` is not simply "null when pending":
 *
 * | Slot | `purpose` | `requesterName` |
 * |---|---|---|
 * | `APPROVED`, someone else's | ✅ shown | ✅ shown |
 * | `PENDING`, someone else's | ❌ `null` | ❌ `null` |
 * | Either, **the caller's own** | ✅ shown | ✅ shown |
 *
 * ⚠️ `D-C18` extends this to origin: a STAFF-created booking renders as any other taken slot. The
 * privacy rule is about the VIEWER, not about who wrote the row.
 */
export class VenueAvailabilitySlotDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;

  /**
   * 🔴 THREE AVAILABILITY STATES, NOT TWO (`TRANSPORT.md` §3.1). Red = taken; **amber = someone else
   * has a pending request**; green = free — the third being the absence of a slot. Collapsing amber
   * into red makes users walk away from a day nothing is holding; collapsing it into green makes
   * them submit without knowing they are competing, which changes what they expect to happen.
   *
   * Only `APPROVED` and `PENDING` ever appear here: rejected and cancelled requests occupy nothing.
   */
  @ApiProperty({
    enum: [BookingStatus.APPROVED, BookingStatus.PENDING],
    description:
      '`APPROVED` — the slot is taken. `PENDING` — somebody has requested it and nothing is holding it yet (`D-C13` rule 4).',
  })
  status!: typeof BookingStatus.APPROVED | typeof BookingStatus.PENDING;

  @ApiProperty({
    description:
      'True when this slot belongs to the calling LINE user’s own request. Drives the `คุณ` badge, and unlocks `purpose`/`requesterName` on the caller’s own pending rows.',
  })
  isMine!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '🔴 `null` on somebody else’s PENDING request (`D-C13`). Non-null on an approved slot and on the caller’s own.',
  })
  purpose!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '🔴 `null` on somebody else’s PENDING request (`D-C13`). Also `null` on a staff-created booking with no LINE requester and no manual override — an unnamed approved slot is normal, not an error.',
  })
  requesterName!: string | null;
}
