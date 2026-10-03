import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditAction } from './audit.dto';

/**
 * `GET /reports/activity/csv` as-is; `GET /reports/activity` adds paging. Date CONTENT is checked in the
 * service by `parseReportRange` (stable `REPORT_*` codes). Ranges INCLUDE today (D-16).
 */
export class ReportsActivityFilterDto {
  @ApiProperty({ format: 'date', example: '2026-09-04' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  startDate!: string;

  @ApiProperty({ format: 'date', example: '2026-10-03' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  endDate!: string;

  @ApiPropertyOptional({ enum: AuditAction, enumName: 'AuditAction' })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    maxLength: 64,
    description: 'Staff id. An unknown id yields an empty result, never a 400.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Case-insensitive substring over event id, target label/detail, summary, note, actor name/department and the action label. Matched in memory, so % and _ are literal.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ReportsActivityQueryDto extends ReportsActivityFilterDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: 'A page past the end is clamped to the last page.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ enum: [10, 20, 50], default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsIn([10, 20, 50])
  limit?: number = 10;
}
