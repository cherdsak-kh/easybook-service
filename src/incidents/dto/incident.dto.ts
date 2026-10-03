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
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import {
  IncidentCallerKind,
  IncidentComponent,
  IncidentSeverity,
} from '../incident.types';

export { IncidentCallerKind, IncidentComponent, IncidentSeverity };

export const INCIDENT_ERROR_CODES = ['INCIDENT_NOT_FOUND'] as const;
export type IncidentErrorCode = (typeof INCIDENT_ERROR_CODES)[number];

/** `startDate`/`endDate` content is checked by `parseReportRange` so the 400 carries a stable code. */
export class IncidentRangeQueryDto {
  @ApiProperty({
    format: 'date',
    example: '2026-09-04',
    description:
      'Bangkok calendar date, YYYY-MM-DD, inclusive. TODAY IS INCLUDED (an error log is about what just happened).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  startDate!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-10-03',
    description:
      'Bangkok calendar date, YYYY-MM-DD, inclusive. Span <= 366 days.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  endDate!: string;
}

export class IncidentFilterDto extends IncidentRangeQueryDto {
  @ApiPropertyOptional({
    enum: IncidentSeverity,
    enumName: 'IncidentSeverity',
  })
  @IsOptional()
  @IsEnum(IncidentSeverity)
  severity?: IncidentSeverity;

  @ApiPropertyOptional({
    enum: IncidentComponent,
    enumName: 'IncidentComponent',
  })
  @IsOptional()
  @IsEnum(IncidentComponent)
  component?: IncidentComponent;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Case-insensitive substring over incident id, trace id, "<status> <method> <path>", message and component label. Matched in memory, so % and _ are literal.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class IncidentListQueryDto extends IncidentFilterDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
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

export class IncidentCallerDto {
  @ApiProperty({ enum: IncidentCallerKind, enumName: 'IncidentCallerKind' })
  kind!: IncidentCallerKind;

  @ApiProperty({
    example: 'staff:cm1abc (ADMIN)',
    description:
      'staff:<id> (<ROLE>), line-user:<masked id>, LINE Platform (webhook), anonymous, or system (<component> <operation>). Never a name, never a full LINE id.',
  })
  label!: string;
}

export class IncidentSummaryDto {
  @ApiProperty({ example: 'ERR-500-0142' })
  id!: string;

  @ApiProperty({
    description: 'Equals the X-Request-Id header of the failing response.',
  })
  traceId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;

  @ApiProperty({ enum: IncidentSeverity, enumName: 'IncidentSeverity' })
  severity!: IncidentSeverity;

  @ApiProperty({ enum: IncidentComponent, enumName: 'IncidentComponent' })
  component!: IncidentComponent;

  @ApiProperty({ type: Number, nullable: true })
  status!: number | null;

  @ApiProperty({ type: String, nullable: true })
  method!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The route template with path parameters substituted. Never a query value.',
  })
  path!: string | null;

  @ApiProperty({ type: String, nullable: true })
  routeTemplate!: string | null;

  @ApiProperty({ description: 'Scrubbed and truncated to 500 characters.' })
  message!: string;

  @ApiProperty({ type: IncidentCallerDto })
  caller!: IncidentCallerDto;

  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;
}

export class IncidentContextDto {
  @ApiPropertyOptional() operation?: string;
  @ApiPropertyOptional() attempt?: number;
  @ApiPropertyOptional() attempts?: number;
  @ApiPropertyOptional() latencyMs?: number;
  @ApiPropertyOptional() budgetMs?: number;
  @ApiPropertyOptional() upstreamStatus?: number;
  @ApiPropertyOptional() lineErrorKind?: string;
  @ApiPropertyOptional() prismaCode?: string;
  @ApiPropertyOptional() sqlState?: string;
  @ApiPropertyOptional() prismaTarget?: string;
  @ApiPropertyOptional() bucket?: string;
  @ApiPropertyOptional() keyPrefix?: string;
  @ApiPropertyOptional() suppressedCount?: number;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Path parameters (scrubbed, <= 64 chars each).',
  })
  params?: Record<string, string>;
}

export class IncidentDetailDto extends IncidentSummaryDto {
  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiProperty({
    type: [String],
    description: 'Query KEYS only, never values.',
  })
  queryKeys!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'At most 50 lines / 8 KB, frames only. Null when the detail was evicted but the ring entry remains.',
  })
  stack!: string | null;

  @ApiProperty({ type: IncidentContextDto })
  context!: IncidentContextDto;
}

export class IncidentRangeDto {
  @ApiProperty({ format: 'date' })
  startDate!: string;

  @ApiProperty({ format: 'date' })
  endDate!: string;

  @ApiProperty({ minimum: 1, maximum: 366 })
  days!: number;
}

export class IncidentRetentionDto {
  @ApiProperty({ example: 5000 })
  maxEntries!: number;

  @ApiProperty({ example: 90 })
  maxDays!: number;
}

export class IncidentPurgeableDto {
  @ApiProperty({
    description:
      'Incidents older than cutoffDate, which DELETE /reports/error-log would remove.',
  })
  count!: number;

  @ApiProperty({
    format: 'date',
    description:
      'First Bangkok day of the 30 วันล่าสุด window. Older incidents are purgeable.',
  })
  cutoffDate!: string;
}

export class IncidentPageDto {
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: IncidentRangeDto })
  range!: IncidentRangeDto;

  @ApiProperty({ type: IncidentRetentionDto })
  retention!: IncidentRetentionDto;

  @ApiProperty({ type: IncidentPurgeableDto })
  purgeable!: IncidentPurgeableDto;

  @ApiProperty({ type: [IncidentSummaryDto] })
  items!: IncidentSummaryDto[];

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ enum: [10, 20, 50] })
  limit!: number;

  @ApiProperty({ description: 'Filtered count.' })
  total!: number;

  @ApiProperty({ minimum: 1 })
  totalPages!: number;
}

export class IncidentAvailabilityDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '100 x (1 - failed / requests) over the range days, unrounded. Null when no request was counted.',
  })
  percent!: number | null;

  @ApiProperty({ description: 'Sum of 5xx responses over the range days.' })
  failed!: number;

  @ApiProperty({ description: 'Sum of requests served over the range days.' })
  requests!: number;

  @ApiProperty({ description: 'Range days with no counter data.' })
  daysWithoutData!: number;

  @ApiProperty({ example: 99.5 })
  targetPercent!: number;
}

export class IncidentCriticalDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  latestAt!: string | null;
}

export class IncidentExternalDto {
  @ApiProperty()
  lineOa!: number;

  @ApiProperty()
  cloudflareR2!: number;

  @ApiProperty()
  redis!: number;
}

export class IncidentKpisDto {
  @ApiProperty({ type: IncidentAvailabilityDto })
  availability!: IncidentAvailabilityDto;

  @ApiProperty({ description: 'Rolling now - 24 h, independent of the range.' })
  last24h!: number;

  @ApiProperty({ description: 'Incidents inside the selected range.' })
  inRange!: number;

  @ApiProperty({ type: IncidentCriticalDto })
  critical!: IncidentCriticalDto;

  @ApiProperty({ type: IncidentExternalDto })
  external!: IncidentExternalDto;
}

export class IncidentKpisResponseDto {
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: IncidentRangeDto })
  range!: IncidentRangeDto;

  @ApiProperty({ type: IncidentKpisDto })
  kpis!: IncidentKpisDto;
}

/** The 404 body of `GET /reports/error-log/detail/:id`. */
export class IncidentCodedErrorDto extends ErrorResponseDto {
  @ApiProperty({ enum: INCIDENT_ERROR_CODES, enumName: 'IncidentErrorCode' })
  code!: IncidentErrorCode;
}
