import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
 * ⚠️ THE RULES CHANGED ON 2026-08-16, AND THE OLD DOC COMMENT HERE ARGUED THE OPPOSITE.
 *
 * It said: minimum 12, no composition rules, citing NIST 800-63B — which advises against
 * composition rules precisely because they push people toward `Password1!`. That argument is still
 * a good one and it is not the one being applied. The policy is now **≥8 plus four character
 * classes**, because the portal's two password screens specify it that way, they show it as a live
 * five-item checklist, and a client must never be the only place a rule lives.
 *
 * What the old rules produced in practice was worse than either policy: the form ACCEPTED an
 * 8-character password the server answered 400 to, and REJECTED a 20-character passphrase the
 * server would have taken. Wrong in both directions at once.
 *
 * Four separate `@Matches` rather than one combined regex, deliberately: the 400 then names the
 * class that failed, matching the checklist item the operator is looking at, instead of saying
 * "invalid" and making them diff their own password by eye.
 */
export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({ minLength: 8, maxLength: 128, format: 'password' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[A-Z]/, {
    message: 'newPassword must contain an uppercase letter.',
  })
  @Matches(/[a-z]/, { message: 'newPassword must contain a lowercase letter.' })
  @Matches(/[0-9]/, { message: 'newPassword must contain a digit.' })
  // `[^A-Za-z0-9\s]` — anything that is not a letter or a digit, EXCEPT whitespace. Whitespace is
  // excluded on purpose: an accidental trailing space would otherwise satisfy "has a special
  // character", and neither the operator nor this message could explain why the rule went green.
  // The screen's label says "เช่น ! @ #" — examples, not the whole set, so Thai characters count.
  @Matches(/[^A-Za-z0-9\s]/, {
    message: 'newPassword must contain a special character.',
  })
  newPassword!: string;
}
