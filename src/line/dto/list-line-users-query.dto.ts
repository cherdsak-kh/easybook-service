import { ApiPropertyOptional } from '@nestjs/swagger';
import { AppAccess } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
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
      'Case-insensitive substring match across the LINE display name, the registered first and ' +
      'last name, the resolved position and department names, and the phone number. A query of ' +
      'three or more digits also matches the phone with its separators removed, so "0812345678" ' +
      'finds "081-234-5678". Trimmed; empty/absent → no search filter.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: AppAccess,
    description:
      'Narrows the list to a single access state. An invalid value is a 400. `UNREGISTERED` is ' +
      'the "ยังไม่ลงทะเบียน" filter — a real state, not the absence of one.',
  })
  @IsOptional()
  @IsEnum(AppAccess)
  access?: AppAccess;

  /**
   * The three orderings the registration screen offers. Absent → `new`, which is what the list
   * answered before this parameter existed.
   *
   * ⚠️ `new`/`old` order by the REGISTRATION date, not `followedAt` (LU-REGDATE-1): the screen's
   * labels say ลงทะเบียนล่าสุด / ลงทะเบียนเก่าสุด and mean it.
   */
  @ApiPropertyOptional({
    enum: ['new', 'old', 'name'],
    default: 'new',
    description:
      'Sort order: `new` (newest registration first — the default), `old` (oldest first), or ' +
      '`name` (by registered name, Thai collation). Rows with no registration sort LAST in every ' +
      'mode, including `old`: having no date is not the same as being the oldest.',
  })
  @IsOptional()
  @IsIn(['new', 'old', 'name'])
  sort?: 'new' | 'old' | 'name' = 'new';
}
