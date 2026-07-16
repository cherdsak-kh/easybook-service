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
 * the former free-text `department`/`role`. `staffId` replaces `studentStaffId`.
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

  @ApiProperty({
    example: '6412345678',
    maxLength: 50,
    description: 'University staff/personnel ID. Globally unique.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  staffId!: string;

  // Deliberately loose (Thai-friendly), mirroring SystemUser.phoneNumber: libphonenumber would
  // reject the local/office formats real users type. Display/notification only — not a lookup key.
  @ApiProperty({ example: '081-234-5678', maxLength: 20 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9+\-() ]{6,20}$/, {
    message: 'phone contains unsupported characters.',
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
