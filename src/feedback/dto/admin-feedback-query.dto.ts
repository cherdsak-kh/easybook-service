import { ApiPropertyOptional } from '@nestjs/swagger';
import { FeedbackStatus, FeedbackType } from '@prisma/client';
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
import {
  FEEDBACK_PAGE_SIZES,
  FEEDBACK_SEARCH_MAX,
  FEEDBACK_VENUE_GENERAL,
  FEEDBACK_VENUE_ID_MAX,
} from '../feedback.constants';

/** Trims a string value, leaving non-strings untouched (mirrors `ListBookingRequestsQueryDto`). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `GET /feedback?page=&limit=&type=&status=&venueId=&q=` — the admin triage list (ADMIN-FEEDBACK-1).
 *
 * ⚠️ THE `page`/`limit` FIELD INITIALIZERS ARE LOAD-BEARING: class-transformer never visits an absent
 * key that carries no `@Expose` metadata, so the defaults survive. Do NOT add `@Expose()` here — the
 * same footgun `ListBookingRequestsQueryDto` records.
 *
 * ⚠️ `@IsOptional()` IS CORRECT ON A QUERY DTO: a query string cannot carry a JSON `null`, so the
 * hole that makes the PATCH body use `@ValidateIf` cannot open here.
 */
export class ListFeedbackQueryDto {
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
    enum: FEEDBACK_PAGE_SIZES,
    default: 10,
    description:
      'Rows per page. Exactly 10, 20 or 50 — anything else is a 400, never clamped: the screen computes each row’s ordinal from the value it sent.',
  })
  @Type(() => Number)
  @IsInt()
  @IsIn([...FEEDBACK_PAGE_SIZES])
  @IsOptional()
  limit: number = 10;

  /** Reuses the EXISTING `FeedbackType` schema name exactly, so `/docs-json` keeps one of it. */
  @ApiPropertyOptional({
    enum: FeedbackType,
    enumName: 'FeedbackType',
    description: 'Narrows to one type — the แจ้งปัญหา / ข้อเสนอแนะ tabs.',
  })
  @IsOptional()
  @IsEnum(FeedbackType)
  type?: FeedbackType;

  /**
   * The FULL enum, `DISMISSED` included: it is accepted harmlessly as a filter (OQ-1) and simply
   * matches nothing today. Only the PATCH body narrows it.
   */
  @ApiPropertyOptional({
    enum: FeedbackStatus,
    enumName: 'FeedbackStatus',
    description: 'Narrows to one stored status.',
  })
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;

  /**
   * ⚠️ AN UNKNOWN ID IS AN EMPTY PAGE, NEVER A 400 OR 404 — this is a FILTER, not the addressed
   * resource. `general` can never be a real id: venue ids are cuids.
   */
  @ApiPropertyOptional({
    maxLength: FEEDBACK_VENUE_ID_MAX,
    description: `A venue id (exact match; an unknown id yields an empty page, not a 400/404) or the literal \`${FEEDBACK_VENUE_GENERAL}\` (reports with no venue — ปัญหาทั่วไป / ไม่ระบุสถานที่). Absent = all venues.`,
    example: FEEDBACK_VENUE_GENERAL,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEEDBACK_VENUE_ID_MAX)
  venueId?: string;

  @ApiPropertyOptional({
    maxLength: FEEDBACK_SEARCH_MAX,
    description:
      'Case-insensitive substring over the reference `code`, the `subject`, the reporter’s registered first/last name and their LINE display name. Trimmed; a leading `#` is stripped; empty → no filter. Does NOT search `description`. ⚠️ It cannot match across the space between a first and last name.',
    example: '#ISS-25690920-001',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(FEEDBACK_SEARCH_MAX)
  q?: string;
}
