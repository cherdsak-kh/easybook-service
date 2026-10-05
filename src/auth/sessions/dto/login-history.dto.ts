import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LoginEventStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { PaginationMetaDto } from '../../../system-users/dto/paginated-system-users-response.dto';
import { LOGIN_HISTORY_PAGE_SIZES } from '../sessions.constants';
import { DeviceInfoDto } from './device-info.dto';

/**
 * `GET /auth/system/login-history?page=&limit=`. Mirrors `ListAnnouncementsQueryDto`.
 *
 * ⚠️ THE FIELD INITIALIZERS ARE LOAD-BEARING: class-transformer never visits an absent key that
 * carries no `@Expose` metadata, so the defaults survive. Do NOT add `@Expose()` here.
 */
export class ListLoginHistoryQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description:
      '1-based. A page beyond the last returns `data: []` with a correct `meta`.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({
    enum: LOGIN_HISTORY_PAGE_SIZES,
    default: 10,
    description:
      'Exactly 10, 20 or 50 — anything else is a 400, never clamped.',
  })
  @Type(() => Number)
  @IsInt()
  @IsIn([...LOGIN_HISTORY_PAGE_SIZES])
  @IsOptional()
  limit: number = 10;
}

export class LoginHistoryItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: LoginEventStatus, enumName: 'LoginEventStatus' })
  status!: LoginEventStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: DeviceInfoDto,
    nullable: true,
    description: 'NULL for FORCE_REVOKED.',
  })
  device!: DeviceInfoDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'NULL for FORCE_REVOKED.',
  })
  ipAddress!: string | null;

  @ApiProperty({
    description:
      'TRUE on the SUCCESS row that created the caller\'s current session ("· อุปกรณ์นี้").',
  })
  isCurrentSession!: boolean;
}

export class LoginHistoryPageDto {
  @ApiProperty({ type: [LoginHistoryItemDto] })
  data!: LoginHistoryItemDto[];

  // IMPORTED from system-users, never redeclared: one `PaginationMetaDto` schema.
  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
