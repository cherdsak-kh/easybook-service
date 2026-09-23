import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnnouncementAudience, AnnouncementFormat } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_DEPARTMENT_ID_MAX,
  ANNOUNCEMENT_TITLE_MAX,
} from '../announcements.constants';

/** Trims a string value, leaving non-strings untouched so `@IsString` can refuse them. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Absence is allowed; an explicit `null` is still validated (and refused by `@IsString`/`@IsEnum`). */
const present = (_o: unknown, v: unknown): boolean => v !== undefined;

/** Absence AND `null` skip validation: `departmentId: null` is meaningful (no department). */
const presentAndNotNull = (_o: unknown, v: unknown): boolean =>
  v !== undefined && v !== null;

const DEPARTMENT_ID_DESCRIPTION =
  'Required (non-null) iff `audience` is `DEPARTMENT`; must be null or omitted when `audience` is `ALL` (400). Must reference an ACTIVE department — an unknown, soft-deleted, or (for non-SUPER_ADMIN) system-reserved id is one indistinguishable 400. A JSON string such as `"3"` is a 400.';

/**
 * `POST /announcements` — create a DRAFT (ANNOUNCE-API-1).
 *
 * ── 🔴 WHAT IS DELIBERATELY ABSENT, AND WHY THE ABSENCE IS THE CONTROL (D-1, D-5, AC-3) ──
 * `status`, `sentAt`, `sentCount`, `createdById`, `id`, `createdAt`, `updatedAt`. `forbidNonWhitelisted`
 * 400s each before the handler runs, so nothing is written. POST therefore ALWAYS inserts `DRAFT`
 * (the column default) and the author is ALWAYS the session user.
 *
 * ── `@ValidateIf`, NOT `@IsOptional` ──
 * `@IsOptional()` skips validation for `null` too, so `{ "body": null }` would reach a `NOT NULL`
 * column. `@ValidateIf((_o, v) => v !== undefined)` accepts absence and refuses `null` (repo
 * CLAUDE.md). `departmentId` is the one field where `null` is a real value.
 *
 * No `@Type(() => Number)` on `departmentId`: this is a JSON body, so `"3"` is a 400, not a 3.
 */
export class CreateAnnouncementDto {
  @ApiProperty({
    minLength: 1,
    maxLength: ANNOUNCEMENT_TITLE_MAX,
    description:
      'หัวข้อ. Trimmed; 1–100 characters after trimming (blank → 400).',
    example: 'ปิดปรับปรุงห้องประชุม 1 วันที่ 25 ก.ย.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ANNOUNCEMENT_TITLE_MAX)
  title!: string;

  @ApiPropertyOptional({
    maxLength: ANNOUNCEMENT_BODY_MAX,
    description:
      'เนื้อหา. Trimmed; at most 1000 characters after trimming. Absent → `""` (a title-only draft). `null` → 400.',
    example: 'ขออภัยในความไม่สะดวก',
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MaxLength(ANNOUNCEMENT_BODY_MAX)
  body?: string;

  @ApiPropertyOptional({
    enum: AnnouncementFormat,
    enumName: 'AnnouncementFormat',
    description: 'Absent → `TEXT`. `null` → 400.',
  })
  @ValidateIf(present)
  @IsEnum(AnnouncementFormat)
  format?: AnnouncementFormat;

  @ApiPropertyOptional({
    enum: AnnouncementAudience,
    enumName: 'AnnouncementAudience',
    description: 'Absent → `ALL`. `null` → 400.',
  })
  @ValidateIf(present)
  @IsEnum(AnnouncementAudience)
  audience?: AnnouncementAudience;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    minimum: 1,
    maximum: ANNOUNCEMENT_DEPARTMENT_ID_MAX,
    description: DEPARTMENT_ID_DESCRIPTION,
    example: 3,
  })
  @ValidateIf(presentAndNotNull)
  @IsInt()
  @Min(1)
  @Max(ANNOUNCEMENT_DEPARTMENT_ID_MAX)
  departmentId?: number | null;
}

/**
 * `PATCH /announcements/:id` — edit a DRAFT (ANNOUNCE-API-1).
 *
 * 🔴 AN EXPLICIT CLASS, NOT `PartialType(CreateAnnouncementDto)` (design S-1): `PartialType` adds
 * `@IsOptional()` to every field, which would let `{ "title": null }` through to a `NOT NULL` column.
 *
 * An empty body `{}` passes the pipe and the SERVICE refuses it with one string,
 * `ANNOUNCEMENT_UPDATE_EMPTY` (design S-2). The audience/department invariant (D-3) is checked by the
 * service on the MERGED (stored + patch) state, so `{ "audience": "DEPARTMENT" }` alone is valid on a
 * row that already has a department, and `{ "audience": "ALL" }` alone clears it.
 */
export class UpdateAnnouncementDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: ANNOUNCEMENT_TITLE_MAX,
    description:
      'หัวข้อ. Trimmed; 1–100 characters after trimming. Blank or `null` → 400.',
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ANNOUNCEMENT_TITLE_MAX)
  title?: string;

  @ApiPropertyOptional({
    maxLength: ANNOUNCEMENT_BODY_MAX,
    description:
      'เนื้อหา. Trimmed; at most 1000 characters after trimming. `""` clears it; `null` → 400.',
  })
  @Transform(trim)
  @ValidateIf(present)
  @IsString()
  @MaxLength(ANNOUNCEMENT_BODY_MAX)
  body?: string;

  @ApiPropertyOptional({
    enum: AnnouncementFormat,
    enumName: 'AnnouncementFormat',
    description: '`null` → 400.',
  })
  @ValidateIf(present)
  @IsEnum(AnnouncementFormat)
  format?: AnnouncementFormat;

  @ApiPropertyOptional({
    enum: AnnouncementAudience,
    enumName: 'AnnouncementAudience',
    description:
      'Switching to `ALL` clears the stored department (send `departmentId: null` or omit it). `null` → 400.',
  })
  @ValidateIf(present)
  @IsEnum(AnnouncementAudience)
  audience?: AnnouncementAudience;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    minimum: 1,
    maximum: ANNOUNCEMENT_DEPARTMENT_ID_MAX,
    description: `${DEPARTMENT_ID_DESCRIPTION} Omitted → the stored department is kept (and re-validated).`,
    example: 3,
  })
  @ValidateIf(presentAndNotNull)
  @IsInt()
  @Min(1)
  @Max(ANNOUNCEMENT_DEPARTMENT_ID_MAX)
  departmentId?: number | null;
}
