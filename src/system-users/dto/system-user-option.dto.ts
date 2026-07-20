import { ApiProperty } from '@nestjs/swagger';

/**
 * `{id,name}` of a `Department` / `PersonnelRole`, resolved for display.
 *
 * Deliberately NOT named `OptionDto`: that name is already an emitted OpenAPI schema
 * (`src/line/dto/registration-options-response.dto.ts`), and a collision would make the frontend's
 * `gen:api` output non-deterministic. Deliberately a new class rather than importing the LINE
 * module's — a two-field DTO is not worth coupling `system-users` to `line`.
 *
 * Resolved WITHOUT a `deletedAt` filter (see `PUBLIC_FIELDS`): a soft-deleted option still resolves
 * its name for an existing assignment, forever (AC-B4).
 */
export class SystemUserOptionDto {
  @ApiProperty({ example: 3 })
  id!: number;

  @ApiProperty({ example: 'Computer Science' })
  name!: string;
}
