import { ApiPropertyOptional } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';
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

/** Trims a string value, leaving non-strings untouched (mirrors the line-users DTO). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The four states the staff screen's status filter offers.
 *
 * ⚠️ THESE ARE NOT COLUMNS. They are derived from three independent flags, and the derivation is
 * a PRECEDENCE, copied from the screen that renders the badge:
 *
 *   deleted   → deletedAt != null                                   (wins over everything)
 *   suspended → isActive === false                                  (wins over pending)
 *   pending   → mustChangePassword === true
 *   active    → everything else
 *
 * The order matters and is easy to get wrong: a suspended user who also owes a password change
 * shows `ระงับการใช้งาน` on screen, so filtering by `รอตั้งรหัสผ่าน` must NOT return them. A filter
 * whose rules disagree with the badge returns rows that visibly contradict the filter that found
 * them, which reads as a broken screen rather than a broken query.
 */
export const STAFF_STATUSES = [
  'active',
  'pending',
  'suspended',
  'deleted',
] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/**
 * Offset pagination, plus the search box and the two filters the staff screen shows.
 *
 * The field initializers are load-bearing **and they survive**: class-transformer's `getKeys()`
 * iterates `Object.keys(source)` plus `@Expose` metadata only, and `@Type()` registers no expose,
 * so an absent `page` is never visited and never clobbered to `undefined`. Do **not** add
 * `@Expose()` here — it would pull both fields into the iteration and `exposeUnsetFields: true`
 * (the default) would overwrite these defaults.
 *
 * `@Type(() => Number)` before `@IsInt()` buys every rejection for free: `?page=abc` → NaN → 400,
 * `?page=1.5` → 400, `?page=0` → 400, `?limit=101` → 400, `?limit=0` → 400.
 */
export class ListSystemUsersQueryDto {
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
      'Case-insensitive substring match on the first name, last name, email or phone number. ' +
      'Trimmed; empty/absent → no search filter. The phone match is on the number **as stored**, ' +
      'so it is format-sensitive: `0812345678` does not match a stored `081-234-5678`.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: SystemRole,
    description: 'Narrows to a single role. An invalid value is a 400.',
  })
  @IsOptional()
  @IsEnum(SystemRole)
  role?: SystemRole;

  /**
   * ⚠️ `deleted` is SUPER_ADMIN-only and that is enforced in the service, not here — a DTO cannot
   * see who is asking. It is also the ONLY way `POST /system-users/:id/restore` is reachable: no
   * other route returns the id of a soft-deleted row (STAFF-DELETED-1).
   */
  @ApiPropertyOptional({
    enum: STAFF_STATUSES,
    description:
      'Derived status filter. `deleted` requires SUPER_ADMIN — any other role asking for it is a ' +
      '403, because hiding the option on screen is UX and never the boundary.',
  })
  @IsOptional()
  @IsIn(STAFF_STATUSES)
  status?: StaffStatus;
}
