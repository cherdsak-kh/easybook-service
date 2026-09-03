import { ApiProperty } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';

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
