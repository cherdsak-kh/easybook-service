import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsUrl, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `PATCH /auth/system/me` — self-profile. EXACTLY ONE field.
 *
 * **THE ALLOWLIST IS THIS DTO'S FIELD SET (AC-B11).** `role`, `isActive`, `departmentId`,
 * `personnelRoleId`, `email`, `password`, `lineUserId`, `mustChangePassword`, `deletedAt` and `id`
 * are ABSENT, so the global `forbidNonWhitelisted: true` rejects each with `400` at the pipe. That
 * absence IS the enforcement — the repo idiom (`UpdateSystemUserDto` already blocks
 * password/email/lineUserId exactly this way).
 *
 * ⚠️ IT USED TO CARRY FOUR: `firstName`, `lastName`, `phoneNumber` and this one. The three were
 * removed on 2026-08-16 because the portal does not offer them. The profile screen renders name,
 * position, department and phone with a padlock and a line saying an administrator maintains them;
 * only the avatar is the holder's to change.
 *
 * Leaving them here would have made that padlock decorative — a field no screen exposes but the API
 * still accepts is a back door, and the fact that nothing in the UI calls it is not a control. It
 * would also have been the second writer of a value the staff-management screen owns: an operator
 * corrects a misspelt name there, and the owner silently changes it back through an endpoint the
 * operator does not know exists.
 *
 * `noFieldDefined` / `AtLeastOneDefined` went with them. With one optional field, "at least one
 * field must be provided" is just "this field is required" said indirectly — `@IsOptional()` still
 * accepts `null` (which clears the avatar, and is the whole point), while `{}` is a no-op PATCH
 * that changes nothing and harms nothing.
 */
export class UpdateOwnProfileDto {
  /**
   * https only. NULLABLE: `@IsOptional()` skips validation on BOTH `null` and `undefined`, so an
   * explicit `null` clears the avatar while an absent key leaves it alone.
   */
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @Transform(trim)
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  profilePictureUrl?: string | null;
}
