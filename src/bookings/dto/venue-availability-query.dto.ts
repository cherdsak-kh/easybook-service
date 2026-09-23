import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * `GET /line-users/venues/:id/availability?from=&to=`.
 *
 * Both bounds are optional and default to the **current calendar month** in the service, which is
 * what the venue detail calendar opens on. The window is half-open `[from, to)` at instant level:
 * a slot is returned when it OVERLAPS the window, not when it is contained by it — a two-day camp
 * that began before `from` still occupies the first day of the range, and a calendar that dropped it
 * would show a free morning that is not free.
 *
 * ⚠️ NO `status` FILTER, and that is deliberate. `TRANSPORT.md` §3.1 requires three availability
 * states, so the endpoint always returns both `approved` and `pending` and lets the caller colour
 * them. A filter would make "collapse amber into red" a one-parameter mistake.
 */
export class VenueAvailabilityQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Inclusive start of the window, ISO 8601 (a bare `2026-09-01` is accepted and read as local midnight). Defaults to the first instant of the current month.',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsISO8601()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Exclusive end of the window, ISO 8601. Defaults to the first instant of next month. Must not be earlier than `from`, and the window may not exceed 366 days.',
    example: '2026-10-01T00:00:00.000Z',
  })
  @IsISO8601()
  @IsOptional()
  to?: string;
}
