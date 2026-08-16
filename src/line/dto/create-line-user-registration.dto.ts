import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Trims a string value, leaving non-strings untouched (mirrors the system-users DTOs). */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The registration form body for `POST /line-users/register`.
 *
 * There is deliberately **no `lineUserId` field** (impersonation guard, LINK-LINE-1): the caller's
 * identity is the verified `sub` from the ID token (`req.lineUserId`), and `forbidNonWhitelisted`
 * turns any client-supplied `lineUserId` into a `400`. Every field is required — a blank or missing
 * value is a `400`.
 *
 * `departmentId`/`personnelRoleId` are auto-increment integer ids referencing the admin-curated
 * `Department` / `PersonnelRole` option tables (validated non-deleted in the service → `400` on a
 * deleted/unknown id). `@Type(() => Number)` makes the string→number coercion explicit and reliable
 * under the global `transform: true` pipe, and `@IsInt()` rejects non-integer values. They replace
 * the former free-text `department`/`role`.
 *
 * The personnel-ID field was removed as a domain concept; a stale client still sending it gets a
 * `400` from `forbidNonWhitelisted`, never a silent accept.
 */
export class CreateLineUserRegistrationDto {
  @ApiProperty({ example: 'Somchai', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Jaidee', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  // Deliberately loose (Thai-friendly), mirroring SystemUser.phoneNumber: libphonenumber would
  // reject the local/office formats real users type. Display/notification only — not a lookup key.
  @ApiProperty({ example: '081-234-5678', maxLength: 30 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  // ⚠️ THE EXTENSION SUFFIX IS THAI, and that is the whole point of this shape (STAFF-PHONE-1).
  // "02-123-4567 ต่อ 101" is how a Thai office number is written, and the old charset-only regex
  // answered 400 for it with a message naming no character. A person then retypes the number
  // without the extension — the data is lost at the keyboard, quietly.
  //
  // A GRAMMAR, not a widened charset: a phone-shaped prefix, then OPTIONALLY a marker and digits.
  // Adding Thai letters to the character class would accept "โทรหาผมสิ" as a phone number. It is
  // this grammar that lets `toPhoneDigits` split on the marker and trust what is on each side.
  @Matches(/^[0-9+\-() ]{6,20}(?:\s*(?:ต่อ|ext\.?)\s*\d{1,6})?$/, {
    message:
      'phone must be digits and separators, optionally followed by ต่อ or ext and an extension.',
  })
  phone!: string;

  @ApiProperty({
    example: 1,
    description:
      'Integer id of a non-deleted Department option (from GET /line-users/registration/options).',
  })
  @Type(() => Number)
  @IsInt()
  departmentId!: number;

  @ApiProperty({
    example: 1,
    description:
      'Integer id of a non-deleted PersonnelRole option (from GET /line-users/registration/options).',
  })
  @Type(() => Number)
  @IsInt()
  personnelRoleId!: number;
}
