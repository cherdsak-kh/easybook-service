import { ApiPropertyOptional } from '@nestjs/swagger';
import { AppAccess } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Trims a string value, leaving non-strings untouched (mirrors the system-users DTOs). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Offset pagination + optional `displayName` search and `access` filter for the LINE users list.
 * Unknown query parameters are a `400` (`forbidNonWhitelisted`).
 *
 * The `page`/`limit` field initializers are load-bearing and they survive: class-transformer's
 * `getKeys()` iterates `Object.keys(source)` plus `@Expose` metadata only, and `@Type()` registers
 * no expose, so an absent `page` is never visited and never clobbered to `undefined`. Do **not** add
 * `@Expose()` here — same footgun documented in `ListSystemUsersQueryDto`.
 *
 * `@Type(() => Number)` before `@IsInt()` buys every rejection for free: `?page=abc` → NaN → 400,
 * `?page=1.5` → 400, `?page=0` → 400, `?limit=101` → 400, `?limit=0` → 400.
 */
export class ListLineUsersQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: '1-based page number.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Case-insensitive substring match on `displayName`. Trimmed; empty/absent → no name filter.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: AppAccess,
    description:
      'Narrows the list to a single access state. An invalid value is a 400.',
  })
  @IsOptional()
  @IsEnum(AppAccess)
  access?: AppAccess;
}
