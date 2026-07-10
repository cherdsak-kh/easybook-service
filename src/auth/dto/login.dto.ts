import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Runs before the validators (`transform: true` → `plainToInstance` then `validate`), so
 * `@IsEmail()` sees the normalised value and the service receives a lowercase email.
 */
const normaliseEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * `forbidNonWhitelisted: true` is global, so this accepts **exactly** `email` and `password`.
 * Anything else — including a `_csrf` body field — is a `400`. The CSRF token is a header.
 */
export class LoginDto {
  @ApiProperty({ example: 'admin@easybook.local', maxLength: 254 })
  @Transform(normaliseEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Deliberately NO @MinLength here. Enforcing the 12-char policy at login would answer `400`
  // for a short guess and `401` for a long one — leaking the policy and aiding enumeration.
  // The minimum belongs on CreateSystemUserDto only. @MaxLength bounds argon2's cost (DoS guard).
  @ApiProperty({
    example: 'correct horse battery staple',
    minLength: 1,
    maxLength: 128,
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}
