import { ApiPropertyOptional } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { BOOKING_SEARCH_MAX } from '../bookings.constants';

/** Trims a string value, leaving non-strings untouched (mirrors `ListVenuesQueryDto`). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The four orderings `#/bookings` offers, named exactly as the prototype names them
 * (`client_portal_prototype.html`, `MB_SORTS`).
 *
 * 🔴 TWO DIMENSIONS OF TIME, TWO DIFFERENT COLUMNS, and conflating them is the mistake the pairing
 * exists to prevent: `created-*` orders by when the request was **submitted** (`createdAt`),
 * `event-*` by when the room is **used** (`firstStartAt`). A request submitted this morning for
 * next March and one submitted last March for tomorrow sit at opposite ends of the list depending
 * on which pair is chosen, and both answers are right.
 */
export const BOOKING_SORTS = [
  'created-desc',
  'created-asc',
  'event-asc',
  'event-desc',
] as const;

export type BookingSort = (typeof BOOKING_SORTS)[number];

/** The prototype's default: newest submission first. */
export const BOOKING_SORT_DEFAULT: BookingSort = 'created-desc';

/**
 * `GET /line-users/bookings?q=&status=&sort=`.
 *
 * ── 🔴 THERE IS NO PAGINATION, AND THAT IS A SCOPE DECISION RATHER THAN AN OMISSION ──
 * This list is one user's own bookings, which is a bounded set in a way the admin lists are not,
 * and it is the same shape `GET /venues` already ships for the client catalogue. Adding `page`
 * later is additive; the thing that would NOT be additive is the client having built its accordion
 * grouping against a paginated list, because four groups computed over page 1 of 5 are four wrong
 * numbers. If this list ever needs pages, the grouping needs a server-side count first.
 *
 * ── 🔴 `status` FILTERS THE STORED STATUS, WHICH IS NOT WHAT THE SCREEN SHOWS ──
 * `#/bookings` paints **six** states out of these **four** plus the clock: a past `APPROVED` reads
 * as `สิ้นสุดแล้ว`, a past `PENDING` as `หมดเวลาพิจารณา`, and its "ประวัติ" chip means all four of
 * `done` / `expired` / `rejected` / `cancelled` at once. None of those three is a stored value, so
 * none of them can be passed here. The derived state is computed by the client from `status` +
 * `lastEndAt`, which the response carries for that purpose — `หมดเวลา` is computed at read time and
 * never stored (`CHECKLIST.md`, Phase 6). Filtering the derived state stays client-side, which the
 * unpaginated list above makes correct rather than merely convenient.
 */
export class ListLineBookingsQueryDto {
  /**
   * ⚠️ THE LEADING `#` IS STRIPPED BY THE SERVER, not by the client. People paste `#BR-25690903-001`
   * out of a LINE chat because that is how the number is written to them, and a search box that
   * answers "no results" to the exact string it just displayed is the search box being wrong.
   */
  @ApiPropertyOptional({
    maxLength: BOOKING_SEARCH_MAX,
    description:
      'Case-insensitive substring match across the booking `code`, the purpose, and the venue name and location. A leading `#` is stripped, so `#BR-25690903-001` and `BR-25690903-001` find the same row. Trimmed; empty/absent → no search filter.',
    example: '#BR-25690903-001',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(BOOKING_SEARCH_MAX)
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    enum: BookingStatus,
    description:
      'Narrows to one STORED status. The screen’s `ประวัติ` chip and its `สิ้นสุดแล้ว` / `หมดเวลาพิจารณา` badges are DERIVED from `status` + `lastEndAt` and cannot be passed here — see the class note.',
  })
  @IsEnum(BookingStatus)
  @IsOptional()
  status?: BookingStatus;

  @ApiPropertyOptional({
    enum: BOOKING_SORTS,
    default: BOOKING_SORT_DEFAULT,
    description:
      '`created-*` orders by submission date, `event-*` by the date the room is used. Ties break on `code` ascending so the order is total and a re-fetch cannot shuffle two rows past each other.',
  })
  @IsIn(BOOKING_SORTS)
  @IsOptional()
  sort: BookingSort = BOOKING_SORT_DEFAULT;
}
