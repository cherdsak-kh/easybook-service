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
  @ApiProperty({ example: 'clx9z8y7x6w5v4u3t2s1r0q9' })
  id!: string;

  @ApiProperty({ example: 'Teacher' })
  name!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  updatedAt!: string;
}
