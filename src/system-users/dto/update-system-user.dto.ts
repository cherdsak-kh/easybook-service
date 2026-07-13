import { ApiPropertyOptional } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
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
 * EXACTLY eight optional fields.
 *
 * `password`, the password digest, `email`, `lineUserId`, `deletedAt`, `createdById`, `id`,
 * `lastLoginAt`, `createdAt` and `updatedAt` simply do not exist here, so the global
 * `forbidNonWhitelisted: true` rejects all ten with `400` at zero code cost (DD-13). A redundant
 * service-layer re-check of a key the pipe already rejected would be unreachable, untestable dead
 * code — the real residual risk is a future dev widening this DTO, which is why
 * `SystemUsersService.update()` builds its Prisma `data` object field by field, never `{...dto}`.
 *
 * Null semantics fall straight out of the decorator choice, with no service-layer branching,
 * because Prisma already treats `undefined` as *skip* and `null` as *set null*:
 *
 * - `@ValidateIf((_o, v) => v !== undefined)` on the six NOT NULL columns — **not**
 *   `@IsOptional()`, which skips validation on `null` as well as `undefined` and would let
 *   `{"role": null}` reach a NOT NULL column and 500. `@ValidateIf` lets `null` fall through to
 *   `@IsEnum`/`@IsString`/`@IsBoolean`, producing the `400` AC-62 requires.
 * - `@IsOptional()` on the two nullable columns, where an explicit `null` *clears* the value.
 *
 * Presence is tested as `value !== undefined`, never `'role' in dto`: `useDefineForClassFields`
 * is effective under `target: ES2023` and class-transformer instantiates via `new targetType()`,
 * so every declared key always exists on the instance (DD-11).
 */
export class UpdateSystemUserDto {
  /**
   * DD-12: the empty-body constraint must be registered on a property, and it must read
   * `Object.values(dto).some(v => v !== undefined)` — a key count is always 8 and thus useless.
   *
   * `firstName`'s `@ValidateIf` therefore also has to admit the empty-body case: class-validator
   * skips **every** validator on a property whose `@ValidateIf` returns false, `@AtLeastOneDefined`
   * included, so a plain `v !== undefined` condition would silently let `{}` through.
   */
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

  @ApiPropertyOptional({ example: 'Teacher', maxLength: 100 })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  position?: string;

  @ApiPropertyOptional({ example: 'Computer Science', maxLength: 120 })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  department?: string;

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

  // SUPER_ADMIN-write-only. Rejected on KEY PRESENCE by the policy, not on value change.
  @ApiPropertyOptional({ enum: SystemRole })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsEnum(SystemRole)
  role?: SystemRole;

  @ApiPropertyOptional({ example: false })
  @ValidateIf((_o, v: unknown) => v !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
