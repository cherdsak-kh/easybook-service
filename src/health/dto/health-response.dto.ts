import { ApiProperty } from '@nestjs/swagger';

/** OpenAPI schema for GET /api/v1/health. Same shape on the 200 and 503 responses. */
export class HealthResponseDto {
  @ApiProperty({
    enum: ['ok', 'error'],
    example: 'ok',
    description:
      'Overall readiness. `ok` (HTTP 200) only when every dependency is `up`; ' +
      '`error` (HTTP 503) when any dependency is `down`.',
  })
  status!: 'ok' | 'error';

  @ApiProperty({
    example: 12.34,
    description: 'Process uptime in seconds.',
  })
  uptime!: number;

  @ApiProperty({
    example: '2026-06-29T14:45:22.815Z',
    description: 'Server time (ISO 8601) when the probe was answered.',
  })
  timestamp!: string;

  @ApiProperty({
    enum: ['up', 'down'],
    example: 'up',
    description: 'Database connectivity (a `SELECT 1` probe via Prisma).',
  })
  db!: 'up' | 'down';

  @ApiProperty({
    enum: ['up', 'down'],
    example: 'up',
    description:
      'Redis connectivity (a `PING` probe). Backs the session store and rate limits.',
  })
  redis!: 'up' | 'down';
}
