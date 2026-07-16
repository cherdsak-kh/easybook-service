import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Body for `POST /departments`. `name` is required, trimmed, and active-name-unique (409 on clash). */
export class CreateDepartmentDto {
  @ApiProperty({ example: 'Computer Science', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/** Body for `PATCH /departments/:id` (rename). Same shape/validation as create. */
export class UpdateDepartmentDto {
  @ApiProperty({ example: 'Computer Engineering', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

/**
 * Public view of a `Department` option. `deletedAt` is deliberately NEVER exposed (mirrors the
 * `SystemUser` discipline) — soft-deleted options simply do not appear in the list.
 */
export class DepartmentResponseDto {
  @ApiProperty({ example: 1, description: 'Auto-increment integer id.' })
  id!: number;

  @ApiProperty({ example: 'Computer Science' })
  name!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  updatedAt!: string;
}
