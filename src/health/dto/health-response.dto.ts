import { ApiProperty } from '@nestjs/swagger';

/** OpenAPI schema for GET /api/v1/health. */
export class HealthResponseDto {
  @ApiProperty({ enum: ['ok'], example: 'ok', description: 'Liveness indicator.' })
  status!: 'ok';

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
}
