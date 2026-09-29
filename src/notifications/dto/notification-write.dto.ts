import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import {
  NOTIFICATION_ID_PATTERN,
  NOTIFICATION_LIMIT_MAX,
} from '../notifications.constants';

/**
 * The E-5/E-6 bodies (design §3.4–§3.5).
 *
 * ── 🔴 `@ValidateIf`, NOT `@IsOptional` ──
 * `@IsOptional()` skips validation for `null` as well as `undefined`, so `{"ids": null}` would read as
 * "absent" — for E-5 that means "mark EVERYTHING read". `@ValidateIf((_o, v) => v !== undefined)`
 * accepts absence and refuses `null` (the `UpdateFeedbackDto` rule).
 *
 * ── WHAT IS DELIBERATELY ABSENT ──
 * `systemUserId`, `targetRole`, `readAt`, `dismissedAt`: the caller comes from the session only, and
 * `forbidNonWhitelisted` 400s each of those keys.
 */

/** `POST /notifications/read-all` (E-5). Optional body: absent / `{}` = every visible unread row. */
export class MarkAdminNotificationsReadDto {
  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: NOTIFICATION_LIMIT_MAX,
    uniqueItems: true,
    description:
      'Omit to mark EVERY visible unread notification. Otherwise 1–50 unique ids. Invisible ids are skipped silently. null is a 400.',
    example: ['clx0v3n0e0000abcd1234efgh'],
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(NOTIFICATION_LIMIT_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(NOTIFICATION_ID_PATTERN, { each: true })
  ids?: string[];
}

/**
 * `DELETE /notifications/bulk` (E-6) — "delete for ME": sets the caller's `dismissedAt`, never deletes a
 * notification row (D-3). Required body.
 *
 * ⚠️ THE EXACTLY-ONE RULE (`ids` XOR `allRead`) IS NOT HERE (design S-9). `@ValidateIf` suppresses every
 * constraint on its property, so a cross-field decorator on either key would be skipped in exactly the
 * "neither" case it has to catch. `NotificationsService.dismiss` throws `NOTIFICATION_DISMISS_TARGET`
 * before any query instead.
 */
export class DismissAdminNotificationsDto {
  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: NOTIFICATION_LIMIT_MAX,
    uniqueItems: true,
    description:
      'Dismiss these ids for the caller. Mutually exclusive with allRead. Invisible or already-dismissed ids are skipped silently.',
    example: ['clx0v3n0e0000abcd1234efgh'],
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(NOTIFICATION_LIMIT_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(NOTIFICATION_ID_PATTERN, { each: true })
  ids?: string[];

  @ApiPropertyOptional({
    type: Boolean,
    enum: [true],
    description:
      'true = dismiss every READ notification the caller can see, across all categories and pages, ignoring the list filters. Mutually exclusive with ids. false is a 400.',
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @Equals(true)
  allRead?: true;
}
