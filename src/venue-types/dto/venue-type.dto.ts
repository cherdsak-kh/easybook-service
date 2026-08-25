import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Body for `POST /venue-types`. `name` is required, trimmed, and active-name-unique (409 on clash). */
export class CreateVenueTypeDto {
  @ApiProperty({ example: 'โรงยิม', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/** Body for `PATCH /venue-types/:id` (rename). Same shape/validation as create. */
export class UpdateVenueTypeDto {
  @ApiProperty({ example: 'โรงยิมและสนามในร่ม', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/**
 * Public view of a `VenueType`. `deletedAt` is deliberately NEVER exposed (mirrors the `SystemUser`
 * and option discipline) — soft-deleted rows simply do not appear in the list.
 */
export class VenueTypeResponseDto {
  @ApiProperty({ example: 1, description: 'Auto-increment integer id.' })
  id!: number;

  @ApiProperty({ example: 'โรงยิม' })
  name!: string;

  @ApiProperty({
    example: false,
    description:
      'READ-ONLY. True only for the tombstone row (visible to SUPER_ADMIN only; always false for everyone else). Settable by no endpoint.',
  })
  isSystemReserved!: boolean;

  @ApiProperty({ example: '2026-08-25T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-08-25T10:00:00.000Z' })
  updatedAt!: string;

  /**
   * How many venues are filed under this category.
   *
   * ⚠️ ONE POPULATION, so there is no split — and that is the one structural difference from
   * `DepartmentResponseDto`, which carries `staffCount` + `registrationCount` because those two
   * tables are shared between back-office staff and LINE registrations. A `venueCount` field beside
   * this one could only ever equal it: two names for one number, free to drift in a future refactor
   * and impossible to disagree about correctly.
   *
   * ⚠️ IT IS 0 FOR EVERY ROW UNTIL `Venue` EXISTS, and that is honest rather than a placeholder: the
   * system currently contains no venues at all, so "0 แห่ง" is the true answer to what the screen is
   * asking. When the `Venue` table lands (VENUE-1) this becomes a real `_count` over it and nothing
   * about this contract changes.
   */
  @ApiProperty({
    example: 3,
    description:
      'Venues filed under this category, excluding soft-deleted ones. 0 for every row until the Venue table exists.',
  })
  holderCount!: number;

  /**
   * ⚠️ NOT THE SAME QUESTION AS `isSystemReserved`, even though on THIS table the two happen to be
   * true of the same single row — and that coincidence is exactly why they must not be collapsed.
   * An operator may create an ordinary category literally NAMED `ไม่พบประเภทสถานที่`; the flag is
   * what keeps that row ordinary, editable and assignable, while this one stays false for it.
   *
   * Derived, never stored: `isSystemReserved && name === TOMBSTONE_VENUE_TYPE_NAME`. Never offer it
   * in a picker — filing a venue under "not found" on purpose is not a choice a form may present —
   * but do show it when it is ALREADY the value, because `<select>` cannot hold a value absent from
   * its list.
   */
  @ApiProperty({
    example: false,
    description:
      'READ-ONLY. True only for the tombstone row that venues are re-pointed to when a category is deleted. Never offer it as a choice; show it only when it is already the current value.',
  })
  isFallback!: boolean;
}
