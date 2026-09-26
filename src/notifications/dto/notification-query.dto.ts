import { ApiPropertyOptional } from '@nestjs/swagger';
import { AdminNotificationCategory } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { sanitizeThaiText } from '../../common/sanitize-thai.util';
import {
  NOTIFICATION_LIMIT_MAX,
  NOTIFICATION_PERIODS,
  NOTIFICATION_SEARCH_MAX,
  type NotificationPeriod,
} from '../notifications.constants';

/**
 * `"true"` → `true`, `"false"` → `false`, anything else passes through UNTOUCHED so `@IsBoolean()`
 * 400s it (plan R-8).
 *
 * 🔴 NEVER `@Type(() => Boolean)`: that is `Boolean("false")`, which is `true`, so `?isRead=false`
 * would silently return the READ rows. A repeated key (`?isRead=true&isRead=false`) arrives as an
 * array and also 400s.
 */
export const toBool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * `GET /notifications?page=&limit=&category=&isRead=&period=&search=` — the caller's feed (E-1).
 *
 * ⚠️ THE `page`/`limit` FIELD INITIALIZERS ARE LOAD-BEARING: class-transformer never visits an absent
 * key that carries no `@Expose` metadata, so the defaults survive. Do NOT add `@Expose()` here — the
 * footgun `ListFeedbackQueryDto` records.
 *
 * ⚠️ `@IsOptional()` IS CORRECT ON A QUERY DTO: a query string cannot carry a JSON `null`.
 *
 * Unknown keys (`systemUserId`, `targetRole`, …) are a 400 through `forbidNonWhitelisted`.
 */
export class ListAdminNotificationsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description:
      '1-based page number. A page beyond the last returns `data: []` with a correct `meta`, not an error.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  /**
   * DELIBERATELY A RANGE, not the house `@IsIn([10, 20, 50])`: the topbar bell asks for 5 and the page
   * for 10/20/50 (plan §3).
   */
  @ApiPropertyOptional({
    minimum: 1,
    maximum: NOTIFICATION_LIMIT_MAX,
    default: 10,
    description:
      'Rows per page, 1–50. The page uses 10/20/50 and the topbar bell uses 5. Outside the range is a 400, never clamped.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(NOTIFICATION_LIMIT_MAX)
  @IsOptional()
  limit: number = 10;

  @ApiPropertyOptional({
    enum: AdminNotificationCategory,
    enumName: 'AdminNotificationCategory',
    description:
      'Narrows to one tab. UPPER_CASE only — the prototype keys (`bookings`, `users`, …) are a 400. Absent = all categories.',
  })
  @IsOptional()
  @IsEnum(AdminNotificationCategory)
  category?: AdminNotificationCategory;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'The CALLER’s own read state: `true` = read, `false` = unread. Exactly the literals `true`/`false`; anything else (`1`, `yes`, empty, a repeated key) is a 400. Absent = both.',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isRead?: boolean;

  @ApiPropertyOptional({
    enum: [...NOTIFICATION_PERIODS],
    enumName: 'AdminNotificationPeriod',
    description:
      'Asia/Bangkok calendar days: `today` = since Bangkok midnight today; `7d` / `30d` = since Bangkok midnight 7 / 30 days before today (so `7d` spans today plus the 7 days before it). Absent = all time.',
  })
  @IsOptional()
  @IsIn([...NOTIFICATION_PERIODS])
  period?: NotificationPeriod;

  /**
   * ⚠️ THE SAME SANITISER `create()` STORES `title`/`body` THROUGH — search and store must agree on
   * what the letters are, or a row on screen answers "not found" (the `ListLineUsersQueryDto` rule).
   * The sanitiser also trims, so `@MaxLength` counts the trimmed value.
   */
  @ApiPropertyOptional({
    maxLength: NOTIFICATION_SEARCH_MAX,
    description:
      'Case-insensitive substring over `title`, `body` and `code`. Trimmed and Thai-normalised; one leading `#` is stripped; empty after that = no filter. `%` and `_` are literal characters. At most 100 characters.',
    example: '#BR-25690903-001',
  })
  @IsOptional()
  @Transform(sanitizeThaiText)
  @IsString()
  @MaxLength(NOTIFICATION_SEARCH_MAX)
  search?: string;
}
