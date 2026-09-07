import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, ValidateIf } from 'class-validator';

/**
 * `GET /line-users/schedule?from=&to=` — the org-wide master schedule behind `#/home` (Phase 7b).
 *
 * Both bounds are optional and default to the **current Bangkok calendar month**, which is the month
 * `#/home` opens on. The window is half-open `[from, to)` at instant level and a slot is returned
 * when it OVERLAPS it, not when it is contained by it — an activity that began yesterday and runs
 * into today still occupies today, and dropping it would draw an empty day that is not empty.
 *
 * ⚠️ NO `venueId`, NO `status`, NO PAGINATION, and all three absences are the point of the endpoint.
 * `#/home` paints the calendar's day dots AND the activity list from ONE response, so narrowing it
 * to a venue would need a second call per venue; and the status filter is fixed at `APPROVED` in the
 * service, because a pending request is not a fact about the school (`D-C13`). Making either a query
 * parameter would put "show me everyone's pending requests" one character away.
 *
 * ⚠️ `@ValidateIf` RATHER THAN `@IsOptional()`, per `CLAUDE.md`'s rule: `@IsOptional()` also skips
 * validation for an explicit `null`, and "absent" and "explicitly null" are not the same statement.
 * Express only ever hands a query value through as a string, so the two behave identically here —
 * this is the defensive form, not a bug fix, and it deliberately differs from the older sibling
 * {@link VenueAvailabilityQueryDto}, which predates the rule being applied to query DTOs.
 */
export class ScheduleQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Inclusive start of the window, ISO 8601 (a bare `2026-09-01` is accepted). Defaults to the first instant of the current Bangkok month.',
    example: '2026-09-01T00:00:00.000Z',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Exclusive end of the window, ISO 8601. Defaults to the first instant of next month. Must not be earlier than `from`, and the window may not exceed 366 days.',
    example: '2026-10-01T00:00:00.000Z',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsISO8601()
  to?: string;
}

/**
 * One approved activity, anywhere in the school, as `#/home` renders it.
 *
 * ⚠️ IT IS A FLAT ROW, NOT A NESTED VENUE OBJECT, and that is deliberate: the screen groups by day
 * and prints "venue · purpose · who", never a venue card. `BookingVenueSummaryDto` would carry the
 * photo array of every venue in the month for nothing.
 *
 * 🔴 NO PRIVACY BRANCH HERE, because there is nothing to hide: every row is `APPROVED`, and an
 * approved activity is a public fact about the school's calendar. `VenueAvailabilitySlotDto` is the
 * DTO that carries `D-C13`'s blanking rule, and it needs one only because it also returns PENDING
 * spans. If this endpoint ever gains a pending state, the blanking has to come with it.
 */
export class LineScheduleSlotDto {
  @ApiProperty({
    description: 'The `BookingSlot` cuid — one span, not a request.',
  })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;

  @ApiProperty({
    description: 'The venue cuid, for the link into `#/venue/:id`.',
  })
  venueId!: string;

  @ApiProperty({ example: 'หอประชุมวารณ' })
  venueName!: string;

  /**
   * ⚠️ NULLABLE ON THE WIRE THOUGH `Venue.venueTypeId` IS A REQUIRED FK. The column can never be
   * null today, so the server always sends a number; the type stays open because `#/home`'s category
   * filter has to have an answer for "uncategorised" the day a venue is allowed to have no category,
   * and widening a non-nullable contract later is the breaking change.
   */
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The venue’s category id, for the shared type-filter row. Always populated today.',
  })
  venueTypeId!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'หอประชุม',
    description: 'The venue’s category name. Always populated today.',
  })
  venueTypeName!: string | null;

  @ApiProperty({
    example: 'ประชุมผู้ปกครองระดับชั้น ม.3',
    description: 'Never blanked — every row on this endpoint is APPROVED.',
  })
  purpose!: string;

  /**
   * The requester's name, from whichever origin wrote the row (`D-C18`): a LIFF request resolves it
   * through the LINE registration, a staff-typed one through the `requesterName` override. `null` is
   * a legitimate answer for a staff booking with no override — an unnamed approved activity is an
   * internal event, not a broken row.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'สมชาย ใจดี',
    description:
      'From the LINE registration, or the staff requester override. Null when a staff booking named nobody.',
  })
  requesterName!: string | null;

  /**
   * ⚠️ COMPUTED FROM THE VERIFIED `sub`, NEVER FROM A CLIENT-SUPPLIED ID. It draws the `คุณ` badge on
   * the requester line — it is presentation, not authorisation, and it grants the caller nothing they
   * would not already see: every row here is public.
   */
  @ApiProperty({
    description: 'True when this activity belongs to the calling LINE user.',
  })
  isMine!: boolean;
}
