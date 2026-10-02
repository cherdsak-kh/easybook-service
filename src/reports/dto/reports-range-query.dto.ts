import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `GET /reports/venues` and `GET /reports/operations` (design §2.4, D-10): dates ONLY. Any other
 * key, including `venueId`/`departmentId`, is a pipe 400 via `forbidNonWhitelisted` — neither
 * prototype has a venue/department picker in its filter bar.
 *
 * Date CONTENT is checked in the service by `parseReportRange`, so the 400 carries a stable
 * `REPORT_*` code (same reason as `ReportsOverviewQueryDto`). Deliberately a separate class from
 * `ReportsOverviewQueryDto`, which stays byte-identical.
 */
export class ReportsRangeQueryDto {
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
    example: '2026-09-30',
    description:
      'Bangkok calendar date, YYYY-MM-DD, inclusive. Inclusive span ≤ 366 days.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  endDate!: string;
}
