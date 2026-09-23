import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  BOOKING_ATTENDEES_MAX,
  BOOKING_CONTACT_PHONE_MAX,
  BOOKING_PURPOSE_MAX,
  BOOKING_REASON_MAX,
  BOOKING_REQUESTER_NAME_MAX,
  BOOKING_SLOTS_MAX,
} from '../bookings.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * ── 🔴 WHY THIS FILE USES `@ValidateIf` AND NOT `@IsOptional` ──
 * `useDefineForClassFields` is effective in this repo (target ES2022), so every declared field
 * EXISTS on the instance and `'slotIds' in dto` is always true. That is not the trap; the trap is
 * that `@IsOptional()` skips every other validator when the value is `null` as well as when it is
 * `undefined`. On a body, `null` is something a client can actually send — and on
 * {@link CancelBookingRequestDto} it would be read as "no list supplied" and CANCEL THE WHOLE
 * BOOKING when the caller sent a list. `@ValidateIf((_o, v) => v !== undefined)` refuses `null` and
 * accepts absence, which is the distinction the routes need.
 *
 * The query DTO on this surface keeps `@IsOptional()`, and that is correct: a query string has no
 * way to carry a JSON `null`.
 */

/**
 * `reject` — the reason is MANDATORY (AC-BR8).
 *
 * ⚠️ `@Transform(trim)` RUNS BEFORE `@IsNotEmpty()`, and that ordering is the whole of AC-BR8's
 * whitespace clause: class-transformer's phase always precedes every validator, so `"   "` is trimmed
 * to `""` and then refused. Dropping the transform would let a reason made of spaces reach the
 * column and print as blank in the requester's LINE chat.
 */
export class RejectBookingRequestDto {
  @ApiProperty({
    maxLength: BOOKING_REASON_MAX,
    description:
      'Why the request is refused. Mandatory — a blank or whitespace-only reason is a 400. Shown RAW to the requester on My Bookings and in LINE, so it is written for them, not for the audit log.',
    example: 'ห้องถูกจัดสรรให้กิจกรรมของโรงเรียนในวันดังกล่าว',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BOOKING_REASON_MAX)
  reason!: string;
}

/**
 * `cancel` — whole booking, or named slots.
 *
 * ⚠️ THE REASON IS MANDATORY IN BOTH SHAPES (AC-BR9). A staff cancellation happens TO somebody who
 * had an approved booking; the LIFF side's unconditional right to withdraw does not apply here.
 */
export class CancelBookingRequestDto {
  @ApiProperty({
    maxLength: BOOKING_REASON_MAX,
    description:
      'Why the booking (or the named slots) is being cancelled. Mandatory for BOTH shapes — blank or whitespace-only is a 400.',
    example: 'ห้องประชุมอยู่ระหว่างซ่อมระบบปรับอากาศ',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BOOKING_REASON_MAX)
  reason!: string;

  /**
   * Absent → cancel every live slot. Present → cancel exactly these.
   *
   * 🔴 `@ValidateIf`, NOT `@IsOptional` — see the file note. `{"slotIds": null}` under `@IsOptional`
   * passes every validator and is then indistinguishable from "absent", so a caller who asked to drop
   * one Wednesday would silently lose all three days. That is destructive and unrecoverable.
   *
   * 🔴 AN ID THAT IS NOT ON THIS BOOKING IS A 400, NEVER A SKIP (AC-BR9).
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      'Omit to cancel the WHOLE booking; supply ids to cancel only those slots. `[]` is a 400 (say what you mean), a duplicate id is a 400, an id belonging to another booking is a 400, and an id already cancelled is a 409. Explicit `null` is a 400 — it is not "omitted".',
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  slotIds?: string[];
}

/** One requested span on a direct booking. Same shape and same rules as the LIFF slot input. */
export class BookingSlotInputDto {
  @ApiProperty({
    format: 'date-time',
    example: '2026-09-10T09:00:00.000Z',
    description:
      'Inclusive start of the span, ISO 8601. Must be in the future (`D-C16`, checked per slot against the real clock).',
  })
  @IsISO8601()
  @IsNotEmpty()
  startAt!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-09-10T12:00:00.000Z',
    description:
      'Exclusive end of the span, ISO 8601. Strictly after `startAt`. Half-open — a slot ending 12:00 and one starting 12:00 do NOT overlap.',
  })
  @IsISO8601()
  @IsNotEmpty()
  endAt!: string;
}

/**
 * `POST /booking-requests/direct` — staff booking a room outright.
 *
 * ── 🔴 WHAT IS ABSENT, AND WHY THE ABSENCE IS THE CONTROL ──
 * `forbidNonWhitelisted: true` makes every undeclared field a 400, so the server owns these outright
 * and no client can propose them: `status` (always `APPROVED` — creation IS the approval, `D-C18`),
 * `createdById` and `approvedById` (both the caller), `approvedAt`, `code`, `firstStartAt`/
 * `lastEndAt`, and the `venueId` copied onto every slot (AC-BR11).
 *
 * ── 🔴 THIS IS A DIFFERENT CLASS FROM `CreateLineBookingDto`, IN A DIFFERENT FILE ──
 * The three `D-C18` overrides below are accepted HERE and must keep being REFUSED on the LIFF route
 * (AC-BR12). Adding them to the client DTO to "share" one class would hand an end-user a way to type
 * a name and a phone that disagree with their own registration.
 */
export class CreateDirectBookingDto {
  @ApiProperty({
    description: 'The venue to lock. Must exist and not be soft-deleted.',
    example: 'clx0v3n0e0000abcd1234efgh',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  venueId!: string;

  @ApiProperty({
    maxLength: BOOKING_PURPOSE_MAX,
    description: 'วัตถุประสงค์ — what the room is for. Mandatory.',
    example: 'ประชุมคณะกรรมการสถานศึกษา',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BOOKING_PURPOSE_MAX)
  purpose!: string;

  /**
   * ⚠️ NOT VALIDATED AGAINST `Venue.capacity`, ON ANY ROUTE. `BOOKING_ATTENDEES_MAX` states the rule:
   * an over-capacity booking is a judgement for the approver, not a validation failure — and on this
   * route the person filling the form IS the approver. The prototype's disabled button is UX.
   */
  @ApiProperty({
    minimum: 1,
    maximum: BOOKING_ATTENDEES_MAX,
    description:
      'จำนวนผู้เข้าร่วม. Deliberately NOT checked against the venue capacity — that is the approver’s judgement, and here the approver is the caller.',
    example: 25,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BOOKING_ATTENDEES_MAX)
  attendees!: number;

  @ApiProperty({
    type: [BookingSlotInputDto],
    minItems: 1,
    maxItems: BOOKING_SLOTS_MAX,
    description:
      'The spans to lock. One entry is a continuous booking; several are the repeat-across-days shape — the same request either way (`D-C13` rule 2).',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BOOKING_SLOTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => BookingSlotInputDto)
  slots!: BookingSlotInputDto[];

  /**
   * Path (A): the booking is FOR a LINE user who has an account.
   *
   * 🔴 IT IS `LineUser.id` — A CUID — NOT THE `U…` LINE-SIDE IDENTIFIER. Three models in
   * `schema.prisma` carry this same-name footgun; passing the `U…` string type-checks and resolves
   * nothing forever.
   */
  @ApiPropertyOptional({
    description:
      'Path (A): `LineUser.id` (a CUID — NOT the `U…` LINE identifier). The booking appears in that user’s My Bookings. Mutually exclusive with the three override fields below. An unknown, soft-deleted or non-ALLOWED user is a 400.',
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  lineUserId?: string;

  /**
   * Path (B): the booking is FOR an outside body with no account — the `D-C18` overrides.
   *
   * The `@ValidateIf` reads "validate when supplied, OR when path (A) was not taken", which is what
   * makes the pair REQUIRED on path (B) and merely refused-if-blank when present. The mutual
   * exclusion itself is enforced in the service, where both fields can be seen at once.
   */
  @ApiPropertyOptional({
    maxLength: BOOKING_REQUESTER_NAME_MAX,
    description:
      'Path (B): who the booking is for. REQUIRED when `lineUserId` is omitted; a 400 when sent alongside `lineUserId` (it is an override, not a second profile store).',
    example: 'สำนักงานเขตพื้นที่การศึกษา',
  })
  @ValidateIf(
    (o: CreateDirectBookingDto, v: unknown) =>
      v !== undefined || o.lineUserId === undefined,
  )
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BOOKING_REQUESTER_NAME_MAX)
  requesterName?: string;

  /**
   * ⚠️ REQUIRED ON PATH (B) BECAUSE THERE IS NO OTHER WAY TO REACH THEM. A booking with no LINE
   * account gets no LINE notification, so a phone number is the only channel that exists if the room
   * has to be taken back.
   */
  @ApiPropertyOptional({
    maxLength: BOOKING_CONTACT_PHONE_MAX,
    description:
      'Path (B): a contact number. REQUIRED when `lineUserId` is omitted — path (B) receives no LINE notification, so this is the only way to reach them. A 400 when sent alongside `lineUserId`.',
    example: '081-234-5678',
  })
  @ValidateIf(
    (o: CreateDirectBookingDto, v: unknown) =>
      v !== undefined || o.lineUserId === undefined,
  )
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BOOKING_CONTACT_PHONE_MAX)
  contactPhone?: string;

  /**
   * ⚠️ THE DEPARTMENT THE BOOKING IS FOR — not the caller's own. Optional on both paths; must be an
   * ACTIVE option (AC-BR13), checked inside the write transaction exactly as `SystemUsersService`
   * checks its own FKs. The FK cannot do that job: `onDelete: Restrict` guards hard deletes only, and
   * a soft-deleted row still physically exists.
   */
  @ApiPropertyOptional({
    description:
      'Path (B): the department the booking is for — NOT the caller’s. Optional. Must be an ACTIVE (`deletedAt: null`) department; anything else is the SAME 400 an unknown id gets. A 400 when sent alongside `lineUserId`.',
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;
}

/**
 * `POST /booking-requests/preflight` — "what would happen if I submitted THESE spans?" (`G1`).
 *
 * ── 🔴 WHY IT REUSES {@link BookingSlotInputDto} RATHER THAN MINTING A SLOT SHAPE ──
 * The answer this endpoint gives is only worth anything if it PREDICTS the answer `direct` gives, and
 * `direct` parses its spans with `parseSlots` over exactly this class. A parallel slot DTO would be a
 * second place for the ISO/format rules to drift, and the drift would show up as a green banner
 * followed by a 400 — a preflight that lies is worse than no preflight at all.
 *
 * ── 🔴 A POST THAT CREATES NOTHING, AND BOTH HALVES OF THAT ARE DELIBERATE ──
 * It is a POST because a list of up to `BOOKING_SLOTS_MAX` spans does not belong in a query string;
 * it therefore carries `@HttpCode(HttpStatus.OK)` on the route (Nest would otherwise answer `201` and
 * claim a resource) and it is subject to CSRF like every other POST on this cookie-session surface.
 */
export class BookingPreflightDto {
  @ApiProperty({
    description:
      'The venue the spans would be booked at. Must exist and not be soft-deleted — anything else is a 404, exactly as on `direct`.',
    example: 'clx0v3n0e0000abcd1234efgh',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  venueId!: string;

  /**
   * ⚠️ THE SAME THREE SEMANTIC REFUSALS `direct` MAKES (`parseSlots`): a span that ends before it
   * starts, one that starts in the past, and two spans of this same list overlapping each other are
   * all a 400 HERE TOO. Accepting them and reporting "no conflict" would tell the operator the form
   * is fine when submitting it is a 400.
   */
  @ApiProperty({
    type: [BookingSlotInputDto],
    minItems: 1,
    maxItems: BOOKING_SLOTS_MAX,
    description:
      'The spans to test. NOT YET SAVED — this is the whole point: `GET /venues/:id/availability` can only answer about rows that exist, and it is behind the LIFF id-token guard besides.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BOOKING_SLOTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => BookingSlotInputDto)
  slots!: BookingSlotInputDto[];
}
