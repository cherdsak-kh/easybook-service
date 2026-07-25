import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppAccess } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Trims a string value, leaving non-strings untouched (mirrors the registration DTOs). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The body for `PATCH /line-users/:id`.
 *
 * `access` is **required** (not `@IsOptional`), so an empty `{}` body is a `400`; any other key is a
 * `400` (`forbidNonWhitelisted`); a value outside `AppAccess` is a `400` (`@IsEnum`).
 *
 * Per the design log (§2.4 + the frozen §7.3 wire contract) the DTO accepts **any** `AppAccess`
 * member, including `PENDING` — approve/block are just the frontend labels the operator sends as
 * `ALLOWED`/`BLOCKED`, and no special-casing of `PENDING` is warranted at the transport boundary.
 *
 * `reason` is the operator-authored revision reason for the Reject action. It is **optional at the
 * transport layer** (meaningless for ALLOWED/BLOCKED), but the service REQUIRES a non-empty trimmed
 * value when `access === REJECTED` (a missing/blank reason on a REJECTED request is a `400`); it is
 * ignored (not persisted) for any non-REJECTED target. Trimming happens HERE (single normalization
 * site) so the service only needs to test emptiness.
 */
export class UpdateLineUserAccessDto {
  @ApiProperty({
    enum: AppAccess,
    example: AppAccess.ALLOWED,
    description:
      "The user's new access state. Approve → ALLOWED, Block → BLOCKED, Reject → REJECTED (the frontend never sends PENDING, but it is accepted).",
  })
  @IsEnum(AppAccess)
  access!: AppAccess;

  @ApiPropertyOptional({
    maxLength: 500,
    example: 'เบอร์โทรศัพท์ไม่ถูกต้อง กรุณากรอกใหม่',
    description:
      'The operator-authored revision reason. Optional at the transport layer (meaningless for ' +
      'ALLOWED/BLOCKED), but the service REQUIRES a non-empty trimmed value when `access === REJECTED` ' +
      '— a missing/blank reason on a REJECTED request is a 400. Ignored (not persisted) for any ' +
      'non-REJECTED target. Max 500 chars.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason?: string;
}
