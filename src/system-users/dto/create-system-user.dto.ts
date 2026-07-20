import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * `lineUserId` is absent by design — no endpoint in this feature can set it, and
 * `forbidNonWhitelisted: true` turns every attempt into a `400` (AC-35). A SUPER_ADMIN typing a
 * cuid could otherwise bind an operator's notification channel to a LINE account nobody has
 * proven ownership of; establishing that link needs LINE-side proof (LINK-LINE-1).
 *
 * `password` is absent by the same mechanism, and for a sharper reason: the server now ISSUES a
 * temporary password (returned once, `mustChangePassword: true`). An admin-chosen password would be
 * a SECOND credential path that bypasses the forced-reset gate entirely. Its absence from this DTO
 * *is* the enforcement — `forbidNonWhitelisted` 400s any attempt to set one.
 */
export class CreateSystemUserDto {
  @ApiProperty({ example: 'ada@easybook.local', maxLength: 254 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Ada', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  firstName!: string;

  @ApiProperty({ example: 'Lovelace', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  lastName!: string;

  @ApiPropertyOptional({ enum: SystemRole, default: SystemRole.STAFF })
  @IsOptional()
  @IsEnum(SystemRole)
  role?: SystemRole;

  // ---- Educational-context profile. No employee/personnel ID field — ruled out by the PO. ----

  // `@IsInt()` with NO `@Type(() => Number)`: the global ValidationPipe runs `transform: true` but
  // NOT `enableImplicitConversion`, so a JSON `3` arrives as a number and `"3"` is correctly a 400.
  // Adding `@Type` would silently accept strings and weaken the contract.
  @ApiProperty({
    example: 3,
    description:
      'Department option id. Must reference an ACTIVE (non-soft-deleted) option — otherwise 400.',
  })
  @IsInt()
  @Min(1)
  departmentId!: number;

  @ApiProperty({
    example: 5,
    description:
      'PersonnelRole option id — the job title ("Position" in the UI). NOT `role`; grants zero privilege. Must reference an ACTIVE option — otherwise 400.',
  })
  @IsInt()
  @Min(1)
  personnelRoleId!: number;

  // Deliberately NOT @IsPhoneNumber('TH'): libphonenumber rejects the office formats back-office
  // staff actually have (extensions, internal short numbers, foreign numbers). The field is
  // display-only — not a lookup key, not unique, not a notification channel.
  @ApiPropertyOptional({ example: '02-123-4567 ext. 101', maxLength: 20 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  @Matches(/^[0-9+\-\s()#.]{6,20}$/, {
    message: 'phoneNumber contains unsupported characters.',
  })
  phoneNumber?: string;

  // https-only is a real control: the value is rendered into an <img src> by a future client, so
  // `javascript:`, `data:` and plain `http:` (mixed content) must all be rejected at the boundary.
  // The backend never fetches this URL — there is no SSRF surface.
  @ApiPropertyOptional({
    example: 'https://cdn.example.com/avatars/ada.jpg',
    maxLength: 2048,
  })
  @IsOptional()
  @Transform(trim)
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  profilePictureUrl?: string;
}
