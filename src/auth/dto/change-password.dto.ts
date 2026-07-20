import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /auth/system/password` — the forced AND voluntary password change. One endpoint, so there is
 * exactly one code path that writes a password digest.
 *
 * No `userId`/`email` field — identity is the session, always. No `confirmPassword` — that is a
 * frontend concern; sending it is a `400` via `forbidNonWhitelisted`.
 *
 * `currentPassword` is REQUIRED (Q7): a hijacked session would otherwise become a permanent account
 * takeover in one request (the attacker sets a password the owner does not know). Requiring it means
 * a session thief must ALSO know the temp password — which, on the forced-reset path, is the one
 * secret the legitimate admin handed the user out-of-band.
 *
 * Rules are deliberately minimal: ≥12 (matches the repo's existing threshold — one number, one
 * place), ≤128 (argon2id input bound), and must differ from the current password. No composition
 * rules: the repo has none today, they measurably reduce entropy in practice, and NIST 800-63B
 * advises against them.
 */
export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({ minLength: 12, maxLength: 128, format: 'password' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}
