import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, ValidateIf, ValidateNested } from 'class-validator';

/** The three themes `#/settings` offers. The single source for both the DTO and the default. */
export const LINE_USER_THEMES = ['light', 'dark', 'system'] as const;

/** The theme a user who has never saved anything gets. */
export const DEFAULT_LINE_USER_THEME = 'system';

/**
 * Which LINE messages the user accepts (`Q-C9` ruling 2 — THREE toggles, not four; the two that
 * were dropped governed features the plan has ruled will not exist).
 *
 * ⚠️ This is the shape of a JSONB column, so PostgreSQL enforces nothing about it. This class and
 * the global `whitelist` + `forbidNonWhitelisted` pipe are the ONLY guard — see the schema comment
 * on `LineUserSettings.notifications`.
 */
export class NotificationPreferencesDto {
  @ApiProperty({
    example: true,
    description:
      'ประกาศและข่าวประชาสัมพันธ์ — announcements, activity news and system updates from the admins.',
  })
  announcements!: boolean;

  @ApiProperty({
    example: true,
    description:
      'ผลการพิจารณาคำขอจองสถานที่ — approved, rejected, or auto-rejected because somebody else was approved first.',
  })
  decisions!: boolean;

  @ApiProperty({
    example: true,
    description:
      'เตือนความจำก่อนถึงเวลาเข้าใช้งาน — 24 hours before, and again 1 hour before.',
  })
  reminders!: boolean;
}

/**
 * What `GET`/`PATCH /api/v1/line-users/settings` answer.
 *
 * ⚠️ A user who has never opened `#/settings` HAS NO ROW, and gets these same defaults with
 * `updatedAt: null`. That is the whole point of `Q-C9`'s defaults-on-read rule: a backfill (or a
 * lazy create on GET) would mint a row for every follower who never visits the screen.
 */
export class LineUserSettingsResponseDto {
  @ApiProperty({
    example: DEFAULT_LINE_USER_THEME,
    description:
      'One of `light` · `dark` · `system`. ⚠️ The CLIENT-LOCAL value stays authoritative for first ' +
      'paint (`Q-C9`); this is the cross-device sync, never a reason to block the first render on a fetch.',
  })
  theme!: string;

  @ApiProperty({ type: NotificationPreferencesDto })
  notifications!: NotificationPreferencesDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-07T12:51:05.000Z',
    description:
      'When the user last saved their settings, or **null** when they never have — in which case ' +
      'every value above is a default and no row exists. Serialised as ISO 8601.',
  })
  updatedAt!: Date | null;
}

/**
 * The `notifications` half of a `PATCH`. Every key is optional and ABSENCE MEANS UNCHANGED
 * (`Q-C9`): `{ "notifications": { "decisions": false } }` must leave `announcements` and
 * `reminders` exactly as they were.
 *
 * 🔴 `@ValidateIf`, NOT `@IsOptional` — the same rule `update-system-user.dto.ts` and
 * `admin-booking-write.dto.ts` state. `@IsOptional` also skips validation for an explicit `null`,
 * so `{ "decisions": null }` would sail through `@IsBoolean` and land a `null` inside a column
 * documented as three booleans. `@ValidateIf((_o, v) => v !== undefined)` skips only a truly absent
 * key, so `null` is a `400`.
 */
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({ example: false })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsBoolean()
  announcements?: boolean;

  @ApiPropertyOptional({ example: false })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsBoolean()
  decisions?: boolean;

  @ApiPropertyOptional({ example: false })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsBoolean()
  reminders?: boolean;
}

/**
 * The body for `PATCH /api/v1/line-users/settings`.
 *
 * ── 🔴 WHAT IS DELIBERATELY ABSENT ──
 * `forbidNonWhitelisted: true` is global, so every field NOT declared here is a `400`:
 *
 * - **`lineUserId`** — identity is the verified `sub` on `req.lineUserId` (`LINK-LINE-1`). A body
 *   field would be a route to editing somebody else's settings.
 * - **`preferences` / `privacy`** — reserved columns. `Q-C9`: *a key that no document describes
 *   does not get written*. They stay `null` through Phase 7, and the way to keep them that way is
 *   to have no DTO field at all.
 *
 * ⚠️ `notifications` is a nested CLASS with `@ValidateNested()` + `@Type()`, never a bare object or
 * a `Record<string, unknown>`. Both of those pass validation and store nonsense in JSONB.
 */
export class UpdateLineUserSettingsDto {
  @ApiPropertyOptional({
    enum: LINE_USER_THEMES,
    example: 'dark',
    description:
      'Absent = unchanged. Anything outside the three values is a 400.',
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsIn(LINE_USER_THEMES)
  theme?: string;

  @ApiPropertyOptional({
    type: UpdateNotificationPreferencesDto,
    description:
      'Merged PER KEY into the stored object — an absent key is unchanged, never reset to its default.',
  })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @ValidateNested()
  @Type(() => UpdateNotificationPreferencesDto)
  notifications?: UpdateNotificationPreferencesDto;
}

/**
 * What `GET /api/v1/line-users/version` answers — the CONSUMER half of `NEEDS_DESIGN.md` §3.
 *
 * ⚠️ Not the same endpoint as the admin `GET /api/v1/system/version`, and not the same payload:
 * that one is behind the cookie session and carries the build/release stamps an operator reads.
 * This one is behind a LINE ID token and carries the one fact `#/version` needs — the version the
 * API is running, so the screen can say whether the bundle and the server agree. Both read the SAME
 * resolver (`resolveAppVersion`), because a screen that compares two numbers is worthless if the
 * two endpoints can disagree about what the server's number is.
 */
export class LineUserVersionResponseDto {
  @ApiProperty({
    example: '0.14.0',
    description:
      'The release train both repositories share (`Q-C8`). `0.x.y` while in development; `1.0.0` on the day the school starts using it.',
  })
  version!: string;

  @ApiProperty({
    example: 'ok',
    description:
      'Always `ok` when the request reached this handler — the client uses it as a liveness marker beside the version comparison.',
  })
  status!: string;
}
