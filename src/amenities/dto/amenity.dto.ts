import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Body for `POST /amenities`. `name` is required, trimmed, and active-name-unique (409 on clash). */
export class CreateAmenityDto {
  @ApiProperty({ example: 'ไมโครโฟนไร้สาย', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/** Body for `PATCH /amenities/:id` (rename). Same shape/validation as create. */
export class UpdateAmenityDto {
  @ApiProperty({ example: 'ไมโครโฟนไร้สาย (2 ตัว)', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/**
 * Public view of an `Amenity`.
 *
 * ⚠️ `isSystemReserved` AND `isFallback` ARE ALWAYS `false` AND ARE NOT COLUMNS — the model has
 * neither field. They are here so the four curated-table screens can share one client component;
 * what they share is a response shape, not a storage shape. Anything reading these to decide
 * behaviour on this table is asking a question with only one possible answer.
 */
export class AmenityResponseDto {
  @ApiProperty({ example: 1, description: 'Auto-increment integer id.' })
  id!: number;

  @ApiProperty({ example: 'โปรเจกเตอร์' })
  name!: string;

  @ApiProperty({
    example: false,
    description:
      'ALWAYS false. This table has no reserved rows — no System Developer row and no tombstone. Present only so the curated-table screens share one response shape.',
  })
  isSystemReserved!: boolean;

  @ApiProperty({
    example: false,
    description:
      'ALWAYS false. An amenity is a tick in a join table, so a delete removes ticks and orphans nothing; there is nothing to re-point and therefore no tombstone row.',
  })
  isFallback!: boolean;

  @ApiProperty({ example: '2026-08-25T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-08-25T10:00:00.000Z' })
  updatedAt!: string;

  /**
   * How many venues provide this amenity — **แห่ง, not คน**, which is the unit difference from the
   * two personnel tables. A venue can hold several amenities at once, so these numbers do not sum to
   * the venue count and must never be made to.
   *
   * 0 for every row until the `Venue` table exists (VENUE-1): the system holds no venues, so no
   * amenity is provided anywhere. That is the true answer, not a placeholder.
   */
  @ApiProperty({
    example: 6,
    description:
      'Venues providing this amenity, excluding soft-deleted ones. 0 for every row until the Venue table exists.',
  })
  holderCount!: number;
}

/**
 * Body of `DELETE /amenities/:id`.
 *
 * ⚠️ THE OTHER THREE CURATED TABLES ANSWER 204 AND THIS ONE DOES NOT, deliberately. Their delete
 * re-points holders to a tombstone — a move the operator was already told about in the confirm
 * dialog. This delete DESTROYS ticks, and the dialog quotes a count before the click ("ขณะนี้มี
 * สถานที่ที่ให้บริการอุปกรณ์นี้ N แห่ง") that another operator can invalidate in between. Returning
 * what actually happened lets the toast confirm the promise instead of repeating it.
 */
export class DeleteAmenityResponseDto {
  @ApiProperty({
    example: 6,
    description:
      'How many venues lost this amenity. 0 while the Venue table does not exist.',
  })
  releasedVenueCount!: number;
}
