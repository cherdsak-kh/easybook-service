import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BOOKING_ATTENDEES_MAX,
  BOOKING_PURPOSE_MAX,
  BOOKING_SLOTS_MAX,
} from '../bookings.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * One requested span. `D-C13` rule 2: the two supported shapes — a continuous single span and a
 * repeat across several days — differ ONLY in how many of these arrive. They are not two kinds of
 * request and must never become two code paths, so there is no `mode` field here and no branch on
 * `slots.length` anywhere below.
 */
export class CreateLineBookingSlotDto {
  @ApiProperty({
    format: 'date-time',
    example: '2026-09-10T09:00:00.000Z',
    description:
      'Inclusive start of the span, ISO 8601. Must be in the future (`D-C16`, checked per slot against the real clock, not against midnight).',
  })
  @IsISO8601()
  @IsNotEmpty()
  startAt!: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-09-10T12:00:00.000Z',
    description:
      'Exclusive end of the span, ISO 8601. Strictly after `startAt`. The interval is half-open — a slot ending 12:00 and one starting 12:00 do NOT overlap.',
  })
  @IsISO8601()
  @IsNotEmpty()
  endAt!: string;
}

/**
 * `POST /line-users/bookings` — a LINE end-user asking for a room.
 *
 * ── 🔴 WHAT IS DELIBERATELY ABSENT, AND WHY THE ABSENCE IS THE CONTROL ──
 * `forbidNonWhitelisted: true` is global, so every field NOT declared here is a `400`. Three are
 * missing on purpose:
 *
 * 1. **`lineUserId`** — the caller's identity is the verified `sub` on `req.lineUserId`
 *    (`LINK-LINE-1`). A body field would be an impersonation route.
 * 2. **`requesterName` / `contactPhone` / `departmentId`** — `D-C18` calls these three the ADMIN
 *    origin's manual overrides, and states 🔴 that on a LIFF request "they stay `null` and the name,
 *    phone and department are read through `lineUserId` → `LineUserRegistration`". Accepting them
 *    here would copy one fact into two places, free to disagree the moment a user corrects their
 *    registration — the failure `VenuePhoto`'s absent `isCover` flag exists to avoid. A client that
 *    sends them gets a `400`, which is the honest answer rather than a silent discard.
 * 3. **`status` / `approvedById` / `approvedAt`** — a client request is `PENDING`, always
 *    (`D-C13` rule 1). Self-approval is not a field an end-user may reach for.
 */
export class CreateLineBookingDto {
  @ApiProperty({
    description:
      'The venue being requested. Must exist, not be deleted, and be OPEN.',
    example: 'clx0v3n0e0000abcd1234efgh',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  venueId!: string;

  /**
   * ⚠️ MANDATORY, and not because a description field is nice to have. `D-C13` rule 5 forces a human
   * to choose between competing requests for the same hours, and that choice cannot be made from
   * times alone — so this and `attendees` are the two facts the approver actually rules on.
   */
  @ApiProperty({
    maxLength: BOOKING_PURPOSE_MAX,
    description:
      'วัตถุประสงค์ — what the room is for. Mandatory (`D-C13`): the approver chooses between overlapping requests and cannot do it from times alone.',
    example: 'ประชุมเตรียมงานกีฬาสี',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BOOKING_PURPOSE_MAX)
  purpose!: string;

  /**
   * ⚠️ NOT CHECKED AGAINST `Venue.capacity`. A room is regularly booked for fewer people than it
   * seats, and an over-capacity request is a judgement for the approver, not a validation failure.
   */
  @ApiProperty({
    minimum: 1,
    maximum: BOOKING_ATTENDEES_MAX,
    description:
      'จำนวนผู้เข้าร่วม. Mandatory, at least 1. Deliberately NOT validated against the venue capacity — that is the approver’s judgement.',
    example: 25,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BOOKING_ATTENDEES_MAX)
  attendees!: number;

  @ApiProperty({
    type: [CreateLineBookingSlotDto],
    minItems: 1,
    maxItems: BOOKING_SLOTS_MAX,
    description:
      'The requested spans. One entry is a continuous booking; several entries are the repeat-across-days shape. Same request either way (`D-C13` rule 2).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BOOKING_SLOTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => CreateLineBookingSlotDto)
  slots!: CreateLineBookingSlotDto[];
}
