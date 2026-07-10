import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Offset pagination. Unknown query parameters are a `400` (`forbidNonWhitelisted`).
 *
 * The field initializers are load-bearing **and they survive**: class-transformer's `getKeys()`
 * iterates `Object.keys(source)` plus `@Expose` metadata only, and `@Type()` registers no expose,
 * so an absent `page` is never visited and never clobbered to `undefined`. Do **not** add
 * `@Expose()` here — it would pull both fields into the iteration and `exposeUnsetFields: true`
 * (the default) would overwrite these defaults.
 *
 * `@Type(() => Number)` before `@IsInt()` buys every rejection for free: `?page=abc` → NaN → 400,
 * `?page=1.5` → 400, `?page=0` → 400, `?limit=101` → 400, `?limit=0` → 400.
 */
export class ListSystemUsersQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: '1-based page number.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;
}
