import { ApiProperty } from '@nestjs/swagger';
import { AppAccess } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * The single-field body for `PATCH /line-users/:id`.
 *
 * `access` is **required** (not `@IsOptional`), so an empty `{}` body is a `400`; any other key is a
 * `400` (`forbidNonWhitelisted`); a value outside `AppAccess` is a `400` (`@IsEnum`).
 *
 * Per the design log (§2.4 + the frozen §7.3 wire contract) the DTO accepts **any** `AppAccess`
 * member, including `PENDING` — approve/block are just the frontend labels the operator sends as
 * `ALLOWED`/`BLOCKED`, and no special-casing of `PENDING` is warranted at the transport boundary.
 */
export class UpdateLineUserAccessDto {
  @ApiProperty({
    enum: AppAccess,
    example: AppAccess.ALLOWED,
    description:
      "The user's new access state. Approve → ALLOWED, Block → BLOCKED (the frontend never sends PENDING, but it is accepted).",
  })
  @IsEnum(AppAccess)
  access!: AppAccess;
}
