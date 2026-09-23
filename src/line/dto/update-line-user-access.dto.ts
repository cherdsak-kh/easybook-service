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
 * `reason` is ONE field serving TWO columns, chosen by the target state — `rejectionReason` on a
 * Reject, `blockReason` on a Block (19 ส.ค. 2569). It stays optional at the transport layer, and the
 * service requires it only for `REJECTED` (a missing/blank reason there is a `400`), because that
 * one is pushed to the user as a LINE message while a block reason is an internal note. For every
 * other target it is still accepted and still not persisted. Trimming happens HERE (single
 * normalization site) so the service only needs to test emptiness.
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
      'The operator-authored reason. Optional at the transport layer, but the service REQUIRES a ' +
      'non-empty trimmed value when `access === REJECTED` (it is pushed to the user on LINE) — a ' +
      'missing/blank reason there is a 400. On `access === BLOCKED` it is optional and persisted as ' +
      '`blockReason`, a back-office-only note. Ignored (not persisted) for any other target. Max 500 chars.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason?: string;
}
