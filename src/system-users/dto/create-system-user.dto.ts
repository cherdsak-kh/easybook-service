import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
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
 */
export class CreateSystemUserDto {
  @ApiProperty({ example: 'ada@easybook.local', maxLength: 254 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, format: 'password' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Ada Lovelace', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ enum: SystemRole, default: SystemRole.STAFF })
  @IsOptional()
  @IsEnum(SystemRole)
  role?: SystemRole;

  // ---- Educational-context profile. No employee/personnel ID field — ruled out by the PO. ----

  @ApiProperty({
    example: 'Teacher',
    maxLength: 100,
    description: 'Free text, e.g. Teacher / Admin Staff / Director.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  position!: string;

  @ApiProperty({
    example: 'Computer Science',
    maxLength: 120,
    description: 'Free text, e.g. academic department or group.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  department!: string;

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
