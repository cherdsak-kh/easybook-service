import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body for `POST /personnel-roles`. A `PersonnelRole` is the LINE end-user's self-declared role
 * (Teacher, Support Staff, …) — it is NOT `SystemRole` (back-office RBAC). A `name` of e.g. "ADMIN"
 * is a plain label and grants no privilege whatsoever.
 */
export class CreatePersonnelRoleDto {
  @ApiProperty({ example: 'Teacher', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/** Body for `PATCH /personnel-roles/:id` (rename). Same shape/validation as create. */
export class UpdatePersonnelRoleDto {
  @ApiProperty({ example: 'Senior Lecturer', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/** Public view of a `PersonnelRole` option. `deletedAt` is NEVER exposed. */
export class PersonnelRoleResponseDto {
  @ApiProperty({ example: 1, description: 'Auto-increment integer id.' })
  id!: number;

  @ApiProperty({ example: 'Teacher' })
  name!: string;

  @ApiProperty({
    example: false,
    description:
      'READ-ONLY. True only for the System-Developer-owned reserved row (visible to SUPER_ADMIN only; always false for everyone else). Settable by no endpoint.',
  })
  isSystemReserved!: boolean;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  updatedAt!: string;

  /**
   * How many people currently hold this option — back-office staff AND LINE registrations added
   * together, because they draw from the same table and "who holds this" is one question.
   *
   * ⚠️ Soft-deleted holders are NOT counted, but they ARE re-pointed when the option is deleted.
   * The number answers "how many people will an operator see move", which is what the delete
   * confirmation needs; the re-point has to touch every referencing row regardless, because the
   * foreign key is required whether or not a row is visible.
   */
  @ApiProperty({
    example: 12,
    description:
      'Holders of this option (staff + registrations), excluding soft-deleted ones.',
  })
  holderCount!: number;

  /**
   * `holderCount` split into the two populations it is summed from (OPT-COUNT-2).
   *
   * The screens need both halves, not the total: the edit dialog and the delete confirmation each
   * state "ผู้ใช้ LINE X คน · เจ้าหน้าที่ระบบ Y คน", because a merged number hides WHICH population
   * a delete is about to move — and re-pointing 8 LINE registrants is a different cleanup from
   * re-pointing 5 back-office accounts.
   */
  @ApiProperty({
    example: 5,
    description:
      'Back-office accounts holding this option, excluding soft-deleted ones.',
  })
  staffCount!: number;

  @ApiProperty({
    example: 7,
    description:
      'LINE registrations holding this option, excluding soft-deleted ones.',
  })
  registrationCount!: number;

  /**
   * ⚠️ NOT THE SAME QUESTION AS `isSystemReserved`, and that is why it exists. Both the System
   * Developer row and the tombstone row carry `isSystemReserved: true`, yet a picker must treat
   * them oppositely: the reserved row is assignable by a SUPER_ADMIN, while the tombstone must
   * never be offered as a choice — filing somebody under "not found" on purpose is not something a
   * form may propose. It is still shown when it is ALREADY the value, because `<select>` has no way
   * to hold a value that is not in its list.
   */
  @ApiProperty({
    example: false,
    description:
      'READ-ONLY. True only for the tombstone row that holders are re-pointed to when an option is deleted. Never offer it as a choice; show it only when it is already the current value.',
  })
  isFallback!: boolean;
}
