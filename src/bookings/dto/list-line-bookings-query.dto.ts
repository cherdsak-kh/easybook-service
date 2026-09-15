import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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
 * The three buckets the `#/bookings` status dropdown offers, spelled exactly as the app's
 * `StatusFilter` spells them (its `''` "all" is an absent parameter).
 */
export const BOOKING_LIST_STATES = ['pending', 'approved', 'history'] as const;

export type BookingListState = (typeof BOOKING_LIST_STATES)[number];

/** Ten booking cards is about three phone screens. */
export const LINE_BOOKINGS_PAGE_SIZE_DEFAULT = 10;

/**
 * `GET /line-users/bookings?q=&state=&venueTypeId=&sort=&page=&limit=` (`CLIENT-PAGINATION-1`).
 *
 * ── 🔴 PAGINATED, SO EVERY FILTER RUNS IN POSTGRES ──
 * Until `CLIENT-PAGINATION-1` this list was unpaginated and the screen filtered its status buckets and
 * venue type in the browser. That is only correct over the WHOLE set: over page 1 of 5 it yields a
 * wrong count and a "load more" that never ends. So `state` and `venueTypeId` are query parameters,
 * and the buckets are computed server-side by `stateWhere()` in `bookings.service.ts`.
 *
 * ── 🔴 `state` IS THE SCREEN'S DERIVED BUCKET, NOT THE STORED STATUS ──
 * `#/bookings` paints six states from five stored statuses plus the clock (`booking-state.ts`
 * `bookingState()`); `history` means `done` / `expired` / `rejected` / `cancelled` at once, and `done`
 * is not a stored value. The previous `status` parameter filtered the STORED enum, which is a
 * different question — `?status=APPROVED` returns last month's approved bookings, which the screen
 * paints as history. It is REMOVED rather than kept alongside: one list with two meanings of "status"
 * is worse than either, and `forbidNonWhitelisted` now turns a stale client into a loud 400 instead of
 * a silently wrong list.
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
    enum: BOOKING_LIST_STATES,
    description:
      'The screen’s status bucket, decided by the SERVER clock. `pending` = PENDING with a live slot. `approved` = APPROVED with a live slot and some slot (cancelled ones included) ending at or after now. `history` = everything else (done, expired, rejected, cancelled). Absent → all. The three buckets partition the set.',
  })
  @IsIn(BOOKING_LIST_STATES)
  @IsOptional()
  state?: BookingListState;

  @ApiPropertyOptional({
    description:
      'Filter by the booking’s venue’s CURRENT category id — the one the card prints. Take the options from `facets.venueTypes`.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  venueTypeId?: number;

  @ApiPropertyOptional({
    enum: BOOKING_SORTS,
    default: BOOKING_SORT_DEFAULT,
    description:
      '`created-*` orders by submission date, `event-*` by the date the room is used. Ties break on `code` ascending so the order is total and a re-fetch cannot shuffle two rows past each other.',
  })
  @IsIn(BOOKING_SORTS)
  @IsOptional()
  sort: BookingSort = BOOKING_SORT_DEFAULT;

  /**
   * Validators copied from `ListLineUsersQueryDto`. The initialisers are load-bearing — do NOT add
   * `@Expose()` (the footgun `ListSystemUsersQueryDto` documents).
   */
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: '1-based page number.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: LINE_BOOKINGS_PAGE_SIZE_DEFAULT,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = LINE_BOOKINGS_PAGE_SIZE_DEFAULT;
}
