import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** The three official forms (PO ruling 2026-10-03: แบบ 1 สรุปภาพรวม, แบบ 2 บัญชีคำขอจอง, แบบ 3 สถิติรายสถานที่). */
export enum ReportTemplate {
  SUMMARY = 'SUMMARY',
  LEDGER = 'LEDGER',
  VENUES = 'VENUES',
}

export enum ReportPeriod {
  TERM = 'TERM',
  MONTH = 'MONTH',
  CUSTOM = 'CUSTOM',
}

/**
 * `GET /reports/export` and `GET /reports/export/xlsx`. Date CONTENT is checked in the service by
 * `parseReportRange` so a bad date carries a stable `REPORT_*` code (same reasoning as
 * `ReportsOverviewQueryDto`); this DTO proves only the transport shape.
 */
export class ReportsExportQueryDto {
  @ApiProperty({ enum: ReportTemplate, enumName: 'ReportTemplate' })
  @IsEnum(ReportTemplate)
  template!: ReportTemplate;

  @ApiProperty({
    enum: ReportPeriod,
    enumName: 'ReportPeriod',
    description:
      "TERM and MONTH require startDate/endDate to be that period's exact bounds (REPORT_PERIOD_MISMATCH otherwise); CUSTOM is any valid range.",
  })
  @IsEnum(ReportPeriod)
  period!: ReportPeriod;

  @ApiProperty({ format: 'date', example: '2026-05-16' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  startDate!: string;

  @ApiProperty({ format: 'date', example: '2026-10-31' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  endDate!: string;

  @ApiPropertyOptional({
    description:
      'Venue cuid. Unknown -> 400 REPORT_VENUE_INVALID; soft-deleted allowed.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  venueId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Department id. Unknown, or reserved for a non-SUPER_ADMIN -> 400 REPORT_DEPARTMENT_INVALID (same body for both).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;
}
