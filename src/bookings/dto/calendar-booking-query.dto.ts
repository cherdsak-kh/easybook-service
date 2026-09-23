import { ApiPropertyOptional } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

/** The only two statuses the calendar paints — the same pair that occupies a venue. */
export const CALENDAR_STATUSES = [
  BookingStatus.APPROVED,
  BookingStatus.PENDING,
] as const;

export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/**
 * The instant shapes `new Date()` parses reliably: `YYYY-MM-DD`, optionally followed by
 * `THH:mm[:ss[.sss]]` and `Z` / `±HH:mm`.
 *
 * ⚠️ `@IsISO8601()` ALONE IS NOT ENOUGH, measured: it accepts ISO week dates (`2026-W37`), ordinal
 * dates (`2026-257`) and the basic format (`20260901`), and `new Date()` turns every one of them into
 * an Invalid Date — which would reach Prisma as `NaN` and answer 500 instead of 400. This pattern is
 * the ECMAScript date-time string format, so anything it admits parses to a finite instant; `strict`
 * on `@IsISO8601` then refuses the calendar-impossible ones (`2026-02-30`, `T25:00`) that `Date`
 * would otherwise roll over silently.
 */
const CALENDAR_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const INSTANT_MESSAGE =
  '$property must be an ISO 8601 calendar date or date-time (e.g. 2026-09-01T00:00:00+07:00).';

/**
 * `GET /booking-requests/calendar?from=&to=&venueId=&status=` — the admin ปฏิทินการจอง.
 *
 * Both bounds are optional and default to the **current Bangkok calendar month** through the same
 * `resolveWindow` the LIFF venue calendar and `#/home` use, so the default month and both refusals
 * agree across all three. The window is half-open `[from, to)` at instant level, and a slot is
 * returned when it OVERLAPS it.
 *
 * ⚠️ `@ValidateIf` ON `from`/`to` RATHER THAN `@IsOptional()`, the form `ScheduleQueryDto` settled on
 * (`CLAUDE.md`). A query string cannot carry a JSON `null`, so this is the defensive form rather than
 * a fix. `venueId`/`status` follow `ListBookingRequestsQueryDto`, which uses `@IsOptional()`.
 */
export class CalendarBookingQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Inclusive start of the window. `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss[.sss]]` with `Z` or `±HH:mm` — send an explicit offset, since Bangkok midnight is 17:00Z of the previous day. Defaults to the first instant of the current Bangkok (UTC+7) month.',
    example: '2026-08-31T17:00:00.000Z',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsISO8601({ strict: true }, { message: INSTANT_MESSAGE })
  @Matches(CALENDAR_INSTANT_PATTERN, { message: INSTANT_MESSAGE })
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Exclusive end of the window, same format as `from`. Defaults to the first instant of the next Bangkok month. Earlier than `from` → 400; a window wider than 366 days → 400; equal to `from` → an empty array.',
    example: '2026-09-30T17:00:00.000Z',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsISO8601({ strict: true }, { message: INSTANT_MESSAGE })
  @Matches(CALENDAR_INSTANT_PATTERN, { message: INSTANT_MESSAGE })
  to?: string;

  /**
   * ⚠️ AN UNKNOWN ID IS AN EMPTY ARRAY, NEVER A 404 — a filter, not the addressed resource, exactly
   * as on `GET /booking-requests`. `Venue.id` is a cuid STRING (plan §6-D1), never a number.
   */
  @ApiPropertyOptional({
    description:
      'Narrows to one venue (its cuid). An unknown or soft-deleted venue yields `[]`, not a 404.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  venueId?: string;

  /**
   * ⚠️ `@IsIn`, NOT `@IsEnum(BookingStatus)`: the calendar only ever paints the two occupying
   * statuses, so `REJECTED`, `CANCELLED` and `EXPIRED` are a 400 rather than a guaranteed-empty
   * answer that looks like a quiet month.
   */
  @ApiPropertyOptional({
    enum: CALENDAR_STATUSES,
    description:
      'Narrows to one status. Absent → both. Any other value, including `REJECTED`/`CANCELLED`/`EXPIRED`, is a 400.',
  })
  @IsOptional()
  @IsIn(CALENDAR_STATUSES)
  status?: CalendarStatus;
}
