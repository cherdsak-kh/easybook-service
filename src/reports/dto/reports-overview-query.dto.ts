import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * `GET /reports/overview` query (design §2.5).
 *
 * ⚠️ DATE **CONTENT** IS CHECKED IN `ReportsService`, NOT HERE. AC-R15 requires a STABLE CODE
 * (`REPORT_DATE_INVALID`, …) for a malformed date, and the global `ValidationPipe` can only answer
 * with the house body (`message: string[]`, no `code`) for anything `class-validator` rejects. Using
 * `@IsDateString` here would therefore downgrade a coded 400 into an uncoded one — deliberately NOT
 * done. This DTO only proves the transport shape (a non-empty, bounded string; class-validator's own
 * job), and `ReportsService` parses/validates the calendar content and the range rules, emitting the
 * codes the design table lists.
 *
 * `@IsOptional()` is correct on a query DTO: a query string cannot carry a JSON `null` (same note as
 * `ListBookingRequestsQueryDto`).
 */
export class ReportsOverviewQueryDto {
  @ApiProperty({
    format: 'date',
    example: '2026-05-16',
    description: 'Bangkok calendar date, YYYY-MM-DD, inclusive.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  startDate!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-10-31',
    description:
      'Bangkok calendar date, YYYY-MM-DD, inclusive. Inclusive span ≤ 366 days.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  endDate!: string;

  @ApiPropertyOptional({
    description:
      'Venue cuid. Unknown → 400 REPORT_VENUE_INVALID; soft-deleted allowed (historical reports).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  venueId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Department id. Unknown, or reserved for a non-SUPER_ADMIN → 400 REPORT_DEPARTMENT_INVALID (same body as unknown — no existence oracle); soft-deleted allowed.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;
}
