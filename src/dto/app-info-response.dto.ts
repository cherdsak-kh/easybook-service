import { ApiProperty } from '@nestjs/swagger';

/** OpenAPI schema for GET / — the unprefixed root welcome banner. */
export class AppInfoResponseDto {
  @ApiProperty({
    example: 'EasyBook API is running',
    description: 'Human-readable confirmation that the service is up.',
  })
  message!: string;

  @ApiProperty({
    example: 'active',
    description:
      'Coarse service-state banner. Always `active` when the root is reachable; ' +
      'dependency-aware readiness lives at GET /api/v1/health.',
  })
  status!: string;

  @ApiProperty({
    example: '2026-07-13T14:45:22.815Z',
    description: 'Server time (ISO 8601) when the banner was produced.',
  })
  timestamp!: string;
}
