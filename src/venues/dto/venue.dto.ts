import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { VENUE_PHOTOS_MAX } from '../venues.constants';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `''` → `null`, so an emptied optional text field CLEARS the column instead of storing a blank
 * string. Two representations of "nothing" in one nullable column is how `location === ''` starts
 * rendering as an empty line where the card expects an em-dash.
 */
const emptyToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

export const VENUE_STATUSES = ['open', 'closed'] as const;
export type VenueStatus = (typeof VENUE_STATUSES)[number];

/**
 * The search box and the two filters the venues screen offers — and only those.
 *
 * ⚠️ NO PAGINATION, and that is a decision rather than an omission. The endpoint returns everything;
 * the footer states a count. Nine venues today, and while nine is not a ceiling, a pager over a list
 * this size is furniture. There is also no `capacity` filter: a range control is the third-biggest
 * thing in the toolbar, and "at least N people" belongs on the LIFF booking form where somebody
 * actually knows N.
 */
export class ListVenuesQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Case-insensitive substring match on the venue NAME or LOCATION. Trimmed; empty/absent → no search filter.',
  })
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  @IsOptional()
  q?: string;

  /**
   * ⚠️ THE RESERVED TOMBSTONE ID IS ACCEPTED HERE, and that is the exact opposite of what `POST` and
   * `PATCH` do with it — on purpose. The tombstone is where venues LAND when their category is
   * deleted, so an operator must be able to filter for "what fell in there" to repair it. What they
   * must not be able to do is FILE a venue into it deliberately, which would make the row mean two
   * different things. Reading a bucket and choosing it are different acts.
   */
  @ApiPropertyOptional({
    description:
      'Filter by category id. The reserved tombstone id is accepted here (unlike on create/update), so orphaned venues can be found and re-filed.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  venueTypeId?: number;

  @ApiPropertyOptional({
    enum: VENUE_STATUSES,
    description: '`open` = เปิดให้จอง · `closed` = ปิดชั่วคราว. Absent → both.',
  })
  @IsIn(VENUE_STATUSES)
  @IsOptional()
  status?: VenueStatus;
}

/**
 * The fields shared by create and update. Kept as one class rather than two so a new column cannot
 * be added to one path and forgotten on the other.
 *
 * ⚠️ `isOpen` AND `closedReason` ARE ABSENT FROM BOTH, and their absence IS the control:
 * `forbidNonWhitelisted: true` turns any attempt to set them into a 400 (AC-S6). Closing requires a
 * reason and reopening clears it, so it is a TRANSITION with its own endpoints — folding it in here
 * would create a path that sets `isOpen: false` with no reason attached, inside a diff somebody
 * skimmed while fixing a typo.
 */
class VenueWritableFields {
  @ApiProperty({ example: 'หอประชุมวารณ', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    example: 4,
    description:
      'Category id. Must be an ACTIVE, non-reserved venue type — anything else is the same 400 as an unknown id.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  venueTypeId!: number;

  @ApiProperty({ example: 900, minimum: 1, maximum: 100000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity!: number;

  @ApiPropertyOptional({
    // ⚠️ `type: String` IS NOT REDUNDANT ON A NULLABLE FIELD. The reflected `design:type` of a
    // `string | null` union is `Object`, so Swagger emits a schema with no `type` at all and
    // `openapi-typescript` renders it as `Record<string, never>` — a frontend that then cannot
    // assign a string to its own location field. Found by the app's `tsc -b`, not by reading.
    type: String,
    example: 'อาคารหอประชุม ชั้น 1',
    maxLength: 200,
    nullable: true,
    description: 'ที่ตั้ง. An empty string clears it.',
  })
  // `@ValidateIf`, not `@IsOptional()` — see the repo note on `useDefineForClassFields`: an explicit
  // `null` must reach the column (that is how the field is CLEARED), and `@IsOptional()` would skip
  // validation for null as well as undefined, which is the same outcome here but for the wrong
  // reason. Being explicit keeps the two cases distinguishable if a NOT NULL column ever copies this.
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(200)
  @IsOptional()
  location?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: 'หอประชุมใหญ่ของโรงเรียน มีเวทีถาวรและระบบไฟเวที',
    maxLength: 500,
    nullable: true,
    description: 'รายละเอียด. An empty string clears it.',
  })
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string | null;

  /**
   * The whole tick set, not a diff. Absent → no ticks (create) / unchanged (update).
   *
   * `@ArrayUnique` because `[3, 3]` would otherwise hit the composite primary key and surface as a
   * P2002 the operator reads as "amenity already exists".
   */
  @ApiPropertyOptional({
    type: [Number],
    example: [1, 3, 4],
    description:
      'The COMPLETE set of amenity ids for this venue — the server replaces, it does not merge. Every id must be an ACTIVE amenity.',
  })
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @IsOptional()
  amenityIds?: number[];

  /**
   * The whole ORDERED photo set, not a diff. `photoUrls[0]` IS THE COVER.
   *
   * ⚠️ EVERY URL MUST ALREADY HAVE BEEN UPLOADED through `POST /venues/photos`. The service checks
   * the bucket prefix; see `INVALID_PHOTO_URL` for why this is stricter than the avatar contract.
   *
   * ⚠️ `@ArrayMaxSize` IS THE REAL CEILING. The dialog also stops at ten and says what it refused,
   * but that is UX — a limit enforced only in a file picker is a suggestion (AC-S8).
   */
  @ApiPropertyOptional({
    type: [String],
    maxItems: VENUE_PHOTOS_MAX,
    description: `The COMPLETE ordered list of photo URLs; index 0 is the cover. Max ${VENUE_PHOTOS_MAX}. Each must be a URL returned by POST /venues/photos.`,
  })
  @IsArray()
  @ArrayMaxSize(VENUE_PHOTOS_MAX)
  @ArrayUnique()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  @IsOptional()
  photoUrls?: string[];
}

/** Body for `POST /venues`. A venue is always created OPEN — the form has no switch in create mode. */
export class CreateVenueDto extends VenueWritableFields {}

/**
 * Body for `PATCH /venues/:id`.
 *
 * Every field is optional, but an omitted `amenityIds` / `photoUrls` means UNCHANGED, not "clear
 * them" — clearing is `[]`. The distinction matters because the form always sends both, so a request
 * that omits one came from somewhere else and almost certainly did not mean to wipe it.
 */
export class UpdateVenueDto {
  @ApiPropertyOptional({ example: 'หอประชุมวารณ', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  venueTypeId?: number;

  @ApiPropertyOptional({ example: 900, minimum: 1, maximum: 100000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({ type: String, maxLength: 200, nullable: true })
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(200)
  @IsOptional()
  location?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 500, nullable: true })
  @ValidateIf((_o, v) => v !== undefined && v !== null)
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string | null;

  @ApiPropertyOptional({ type: [Number], example: [1, 3] })
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @IsOptional()
  amenityIds?: number[];

  @ApiPropertyOptional({ type: [String], maxItems: VENUE_PHOTOS_MAX })
  @IsArray()
  @ArrayMaxSize(VENUE_PHOTOS_MAX)
  @ArrayUnique()
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  @IsOptional()
  photoUrls?: string[];
}

/** Body for `POST /venues/:id/close`. The reason is REQUIRED — see `CLOSE_REASON_REQUIRED`. */
export class CloseVenueDto {
  @ApiProperty({
    example: 'ปิดปรับปรุงพื้นสนามถึง 30 ก.ย. 2569',
    maxLength: 500,
    description:
      'Shown on the venue card and, once LIFF exists, to every end user who tries to book the room. A blank or whitespace-only reason is a 400.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** Body for `DELETE /venues/photos` — discarding an object the operator uploaded and then cancelled. */
export class DiscardVenuePhotoDto {
  @ApiProperty({
    description:
      'A URL previously returned by POST /venues/photos that is NOT referenced by any venue. Referenced URLs are refused.',
  })
  @Transform(trim)
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;
}

/** The category, as it appears nested on a venue. */
export class VenueTypeSummaryDto {
  @ApiProperty({ example: 4 })
  id!: number;

  @ApiProperty({ example: 'หอประชุม' })
  name!: string;

  /**
   * ⚠️ CARRIED ON THE NESTED OBJECT SO THE CARD CAN RENDER IT DIFFERENTLY. A venue whose category was
   * deleted sits on the tombstone, and `ไม่พบประเภทสถานที่` printed in the same blue badge as
   * `โรงยิม` reads as a category somebody chose. The screen paints it slate instead — the colour this
   * portal already uses for "a system placeholder, not a real value".
   *
   * The client must key that off this FLAG and never off the name. The string is the one thing a
   * translator would edit without thinking, and a name match would turn that edit into orphaned
   * venues quietly rendering as an ordinary category.
   */
  @ApiProperty({
    example: false,
    description:
      'True only for the reserved tombstone category. Render it differently; never match on the name.',
  })
  isFallback!: boolean;
}

/** One photo. `position` is 0-based and 0 IS the cover. */
export class VenuePhotoDto {
  @ApiProperty({ example: 'clx0000000000000000000000' })
  id!: string;

  @ApiProperty({ example: 'https://cdn.example.com/venues/9f8e….jpg' })
  url!: string;

  @ApiProperty({ example: 0, description: '0-based. Position 0 is the cover.' })
  position!: number;
}

/** One amenity tick, resolved to a name. */
export class VenueAmenityDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'เครื่องเสียง' })
  name!: string;
}

/**
 * Public view of a `Venue`. `deletedAt` is NEVER exposed — soft-deleted rows simply do not appear.
 */
export class VenueResponseDto {
  @ApiProperty({ example: 'clx0000000000000000000000' })
  id!: string;

  @ApiProperty({ example: 'หอประชุมวารณ' })
  name!: string;

  /**
   * ⚠️ NESTED AND RESOLVED WITHOUT A `deletedAt` FILTER, which is the read half of the asymmetry
   * `CLAUDE.md` states for `SystemUser.departmentId`. An existing venue keeps resolving its category
   * name forever, even after that category is soft-deleted; adding the filter would return `null`
   * into a non-nullable DTO field and 500 the entire list.
   */
  @ApiProperty({ type: VenueTypeSummaryDto })
  venueType!: VenueTypeSummaryDto;

  @ApiProperty({ example: 900 })
  capacity!: number;

  @ApiProperty({
    type: String,
    example: 'อาคารหอประชุม ชั้น 1',
    nullable: true,
  })
  location!: string | null;

  @ApiProperty({
    type: String,
    example: 'มีเวทีถาวรและระบบไฟเวที',
    nullable: true,
  })
  description!: string | null;

  @ApiProperty({
    example: true,
    description:
      'เปิดให้จอง. False = ปิดชั่วคราว — still visible to end users, but accepts no new booking requests. Changed only via POST /venues/:id/close and /reopen.',
  })
  isOpen!: boolean;

  @ApiProperty({
    type: String,
    example: null,
    nullable: true,
    description:
      'Non-null if and only if `isOpen` is false. Cleared on every reopen.',
  })
  closedReason!: string | null;

  @ApiProperty({
    type: [VenuePhotoDto],
    description:
      'Ordered. Index 0 is the cover. Empty for a venue with no photos yet.',
  })
  photos!: VenuePhotoDto[];

  @ApiProperty({ type: [VenueAmenityDto], description: 'Ordered `name ASC`.' })
  amenities!: VenueAmenityDto[];

  @ApiProperty({ example: '2026-08-25T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-08-25T10:00:00.000Z' })
  updatedAt!: string;
}

/** `POST /venues/photos` — the object exists in the bucket; nothing references it yet. */
export class VenuePhotoUploadResponseDto {
  @ApiProperty({
    description:
      'The durable https URL of the stored object. Put it in `photoUrls` on the next create/update, or discard it with DELETE /venues/photos.',
  })
  url!: string;
}
