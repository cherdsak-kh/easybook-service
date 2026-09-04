import { ApiPropertyOptional } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { BOOKING_SEARCH_MAX } from '../bookings.constants';

/** Trims a string value, leaving non-strings untouched (mirrors `ListVenuesQueryDto`). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The four orderings the approval queue offers. Named exactly as the client half names them, so one
 * vocabulary spans both screens.
 *
 * 🔴 TWO DIMENSIONS OF TIME, TWO DIFFERENT COLUMNS: `created-*` orders by when the request was
 * SUBMITTED (`createdAt`), `event-*` by when the room is USED (`firstStartAt`).
 */
export const BOOKING_REQUEST_SORTS = [
  'created-desc',
  'event-asc',
  'created-asc',
  'event-desc',
] as const;

export type BookingRequestSort = (typeof BOOKING_REQUEST_SORTS)[number];

/** Newest submission first — the queue's opening view. */
export const BOOKING_REQUEST_SORT_DEFAULT: BookingRequestSort = 'created-desc';

/**
 * The three page sizes the screen's segmented control offers. Nothing else is accepted.
 *
 * 🔴 A VALUE OUTSIDE THIS SET IS A `400`, NOT A CLAMP, and the reasoning is specific rather than
 * stylistic:
 *   1. `forbidNonWhitelisted: true` already sets this repo's standard — the transport boundary is
 *      strict and SAYS SO when it refuses.
 *   2. The screen prints each row's ordinal as `(page - 1) * limit + i` from the limit the CLIENT
 *      holds. A silent clamp to 50 would make every ordinal on the page wrong, with no signal
 *      anywhere that the server had disagreed.
 *   3. There are three buttons, not a free-text box, so a fourth value is a client bug rather than a
 *      user typing too large a number.
 *
 * ⚠️ DELIBERATELY UNLIKE `GET /line-users`, which uses `@Min(1) @Max(100)`: that screen offers a free
 * numeric input, so clamping the range is the right shape there and would be the wrong shape here.
 */
export const BOOKING_REQUEST_PAGE_SIZES = [10, 20, 50] as const;

/**
 * `GET /booking-requests?page=&limit=&search=&venueId=&status=&sort=`.
 *
 * ⚠️ THE `page`/`limit` FIELD INITIALIZERS ARE LOAD-BEARING AND THEY SURVIVE: class-transformer's
 * `getKeys()` iterates `Object.keys(source)` plus `@Expose` metadata only, and `@Type()` registers no
 * expose, so an absent `page` is never visited and never clobbered to `undefined`. Do NOT add
 * `@Expose()` here — the same footgun `ListSystemUsersQueryDto` and `ListLineUsersQueryDto` warn
 * about.
 *
 * ⚠️ `@IsOptional()` IS CORRECT ON A QUERY DTO, unlike on the body DTOs on this surface. A query
 * string cannot carry a JSON `null`: a key is either absent or a string, so the `null`-slips-through
 * hole that `useDefineForClassFields` opens in a body has no way to occur here.
 */
export class ListBookingRequestsQueryDto {
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
    enum: BOOKING_REQUEST_PAGE_SIZES,
    default: 10,
    description:
      'Rows per page. Exactly 10, 20 or 50 — any other value is a 400 rather than a silent clamp, because the screen computes each row’s ordinal from the value it sent.',
  })
  @Type(() => Number)
  @IsInt()
  @IsIn([...BOOKING_REQUEST_PAGE_SIZES])
  @IsOptional()
  limit: number = 10;

  /**
   * ⚠️ THE LEADING `#` IS STRIPPED. Staff paste `#BR-25690903-001` because that is the form the
   * number is written in, and a queue that answered "no results" to the string it just printed would
   * be the product being wrong about its own identifier.
   */
  @ApiPropertyOptional({
    maxLength: BOOKING_SEARCH_MAX,
    description:
      'Case-insensitive substring match across the booking `code`, the purpose, the venue name, and the requester’s name — which has TWO sources: `requesterName` on a staff-created booking, or the LINE user’s registered first/last name. A leading `#` is stripped. ⚠️ It cannot match across the space between a first and last name ("สมชาย ใจดี" finds nothing), the same limitation `GET /line-users` documents. Trimmed; empty/absent → no search filter.',
    example: '#BR-25690903-001',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(BOOKING_SEARCH_MAX)
  search?: string;

  /**
   * ⚠️ AN UNKNOWN ID IS AN EMPTY LIST, NEVER A 404. This is a FILTER, not the resource being
   * addressed: `total: 0` is the honest answer to "requests at a venue that does not exist".
   */
  @ApiPropertyOptional({
    description:
      'Narrows to one venue. An unknown id yields an empty list with `total: 0`, not a 404 — it is a filter, not the addressed resource.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  venueId?: string;

  /**
   * ⚠️ THERE IS NO `EXPIRED` VALUE AND NONE MAY BE ADDED. "หมดอายุ" is `status = PENDING AND
   * lastEndAt < now`, computed at read time and surfaced as `isExpired` on every row — there is no
   * fifth stored status and no cron that would write one.
   */
  @ApiPropertyOptional({
    enum: BookingStatus,
    description:
      'Narrows to one stored status; absent means the `ทั้งหมด` tab. The screen’s "หมดอายุ" state is NOT a value here — it is derived (`status = PENDING && lastEndAt < now`) and returned as `isExpired`.',
  })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({
    enum: BOOKING_REQUEST_SORTS,
    default: BOOKING_REQUEST_SORT_DEFAULT,
    description:
      '`created-*` orders by submission date, `event-*` by the date the room is used (`firstStartAt`, an indexed scalar — never an aggregate over the slots). Ties break on `code` ascending so the order is total and a re-fetch cannot shuffle two rows past each other.',
  })
  @IsOptional()
  @IsIn(BOOKING_REQUEST_SORTS)
  sort: BookingRequestSort = BOOKING_REQUEST_SORT_DEFAULT;
}
