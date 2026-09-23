import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  CANNED_REPLY_SORT_ORDER_MAX,
  CANNED_REPLY_TEXT_MAX,
  CANNED_REPLY_TITLE_MAX,
} from '../canned-replies.constants';

/**
 * Copied from `announcement-write.dto.ts` rather than imported across modules (design §3.3).
 * Trims a string value, leaving non-strings untouched so `@IsString` can refuse them.
 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Absence is allowed; an explicit `null` is still validated (and refused). */
const present = (_o: unknown, v: unknown): boolean => v !== undefined;

const TITLE_DESCRIPTION = 'Trimmed; 1–100 characters after trimming.';
const TEXT_DESCRIPTION =
  'The snippet staff copy. Trimmed; 1–1000 characters after trimming.';
const SORT_ORDER_DESCRIPTION =
  'Display order, ascending; ties break on `createdAt` then `id`. Duplicates are allowed. A JSON string such as "3" is a 400.';

/**
 * `POST /canned-replies` (ANNOUNCE-API-5, D-5).
 *
 * `id`, `createdAt`, `updatedAt` are deliberately absent: `forbidNonWhitelisted` 400s them. No
 * `@Type(() => Number)` on `sortOrder`: this is a JSON body, so `"3"` is a 400, not a 3.
 */
export class CreateCannedReplyDto {
  @ApiProperty({
    minLength: 1,
    maxLength: CANNED_REPLY_TITLE_MAX,
    description: TITLE_DESCRIPTION,
    example: 'แจ้งวิธีจองสถานที่',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CANNED_REPLY_TITLE_MAX)
  title!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: CANNED_REPLY_TEXT_MAX,
    description: TEXT_DESCRIPTION,
    example: 'สวัสดีค่ะ จองสถานที่ได้ที่เมนู "จองสถานที่" ด้านล่างห้องแชทนี้',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CANNED_REPLY_TEXT_MAX)
  text!: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: CANNED_REPLY_SORT_ORDER_MAX,
    description: `${SORT_ORDER_DESCRIPTION} Omitted → one past the current maximum (bottom of the list), capped at 9999; 0 on an empty table. \`null\` → 400.`,
    example: 4,
  })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(CANNED_REPLY_SORT_ORDER_MAX)
  sortOrder?: number;
}

/**
 * `PATCH /canned-replies/:id` (ANNOUNCE-API-5, D-5).
 *
 * 🔴 AN EXPLICIT CLASS, NOT `PartialType(CreateCannedReplyDto)` (phase 1 S-1): `PartialType` adds
 * `@IsOptional()` to every field, which would let `{ "title": null }` through to a `NOT NULL` column.
 *
 * An empty body `{}` passes the pipe and the SERVICE refuses it with the coded
 * `CANNED_REPLY_UPDATE_EMPTY`.
 */
export class UpdateCannedReplyDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: CANNED_REPLY_TITLE_MAX,
    description: `${TITLE_DESCRIPTION} Blank or \`null\` → 400.`,
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CANNED_REPLY_TITLE_MAX)
  title?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: CANNED_REPLY_TEXT_MAX,
    description: `${TEXT_DESCRIPTION} Blank or \`null\` → 400.`,
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CANNED_REPLY_TEXT_MAX)
  text?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: CANNED_REPLY_SORT_ORDER_MAX,
    description: `${SORT_ORDER_DESCRIPTION} \`null\` → 400.`,
  })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(CANNED_REPLY_SORT_ORDER_MAX)
  sortOrder?: number;
}
