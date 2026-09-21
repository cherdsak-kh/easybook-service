import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ANNOUNCEMENT_PAGE_SIZES,
  ANNOUNCEMENT_SEARCH_MAX,
  ANNOUNCEMENT_STATUS_FILTERS,
  type AnnouncementStatusFilter,
} from '../announcements.constants';

/** Trims a string value, leaving non-strings untouched so `@IsString` can refuse them. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `GET /announcements?page=&limit=&status=&q=` — the admin list (ANNOUNCE-API-1). Mirrors
 * `ListFeedbackQueryDto`.
 *
 * ⚠️ THE FIELD INITIALIZERS ARE LOAD-BEARING: class-transformer never visits an absent key that
 * carries no `@Expose` metadata, so the defaults survive. Do NOT add `@Expose()` here — the same
 * footgun `ListFeedbackQueryDto` and `ListBookingRequestsQueryDto` record.
 *
 * ⚠️ `@IsOptional()` IS CORRECT ON A QUERY DTO: a query string cannot carry a JSON `null`, so the
 * hole that makes the write DTOs use `@ValidateIf` cannot open here.
 */
export class ListAnnouncementsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description:
      '1-based page number. A page beyond the last returns `data: []` with a correct `meta`, not an error.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({
    enum: ANNOUNCEMENT_PAGE_SIZES,
    default: 10,
    description:
      'Rows per page. Exactly 10, 20 or 50 — anything else is a 400, never clamped.',
  })
  @Type(() => Number)
  @IsInt()
  @IsIn([...ANNOUNCEMENT_PAGE_SIZES])
  @IsOptional()
  limit: number = 10;

  /**
   * 🔴 `enumName: 'AnnouncementStatusFilter'`, NEVER `'AnnouncementStatus'` (design S-3) — see
   * `ANNOUNCEMENT_STATUS_FILTERS`. Uppercase `DRAFT` is an unknown value here, so a 400.
   */
  @ApiPropertyOptional({
    enum: ANNOUNCEMENT_STATUS_FILTERS,
    enumName: 'AnnouncementStatusFilter',
    default: 'all',
    description:
      '`draft` → status DRAFT, `sent` → status SENT, `all` → no status predicate. Lowercase only.',
  })
  @IsOptional()
  @IsIn([...ANNOUNCEMENT_STATUS_FILTERS])
  status: AnnouncementStatusFilter = 'all';

  @ApiPropertyOptional({
    maxLength: ANNOUNCEMENT_SEARCH_MAX,
    description:
      'Case-insensitive substring over `title` ONLY (never `body`). Trimmed; empty → no filter. `%` and `_` match literally.',
    example: 'ปิดปรับปรุง',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(ANNOUNCEMENT_SEARCH_MAX)
  q?: string;
}
