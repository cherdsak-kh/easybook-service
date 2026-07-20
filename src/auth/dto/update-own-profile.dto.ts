import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { AtLeastOneDefined } from '../../common/validators/at-least-one-defined.validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** True when the caller sent nothing at all — an empty `PATCH` body. */
const noFieldDefined = (dto: object): boolean =>
  !Object.values(dto).some((v) => v !== undefined);

/**
 * `PATCH /auth/system/me` — self-profile. EXACTLY four fields (closes `SELF-PROFILE-1`).
 *
 * **THE ALLOWLIST IS THIS DTO'S FIELD SET (AC-B11).** `role`, `isActive`, `departmentId`,
 * `personnelRoleId`, `email`, `password`, `lineUserId`, `mustChangePassword`, `deletedAt` and `id`
 * are ABSENT, so the global `forbidNonWhitelisted: true` rejects each with `400` at the pipe. That
 * absence IS the enforcement — the repo idiom (`UpdateSystemUserDto` already blocks
 * password/email/lineUserId exactly this way).
 *
 * **No `canPatch()` carve-out** — `SELF-PROFILE-1` says so explicitly and it is right: `canPatch`
 * exists to decide *actor vs. target*, and here there is no target but self and no invariant-bearing
 * field in the body. Routing self-edits through it would mean the policy answers "may I edit my own
 * last name?", which is not an authorization question. `system-users.policy.ts` is NOT called by this
 * endpoint and does not change for it (AC-B12 holds: no second matrix appears, because none is needed).
 *
 * Copied verbatim from `UpdateSystemUserDto`'s idioms, including the two traps this repo has already
 * paid for: `@ValidateIf((_o,v)=>v!==undefined)` on the NOT NULL columns (not `@IsOptional()`, which
 * would let `{"firstName": null}` reach a NOT NULL column and 500), and `noFieldDefined` on the first
 * property so `{}` is a `400` (`useDefineForClassFields` makes `'x' in dto` always true).
 */
export class UpdateOwnProfileDto {
  @AtLeastOneDefined({ message: 'At least one field must be provided.' })
  @ApiPropertyOptional({ example: 'Ada', maxLength: 120 })
  @ValidateIf((o: object, v: unknown) => v !== undefined || noFieldDefined(o))
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Lovelace', maxLength: 120 })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  lastName?: string;

  // The two NULLABLE columns: @IsOptional() skips on null AND undefined -> explicit null clears.
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '02-123-4567 ext. 101',
    maxLength: 20,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  @Matches(/^[0-9+\-\s()#.]{6,20}$/, {
    message: 'phoneNumber contains unsupported characters.',
  })
  phoneNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2048 })
  @IsOptional()
  @Transform(trim)
  @MaxLength(2048)
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: true })
  profilePictureUrl?: string | null;
}
