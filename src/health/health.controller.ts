import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HealthResponseDto } from './dto/health-response.dto';
import { HealthService } from './health.service';

/**
 * Operational readiness probe. Route: GET /api/v1/health
 *
 * This is a READINESS gate, not a bare liveness ping: it actively probes PostgreSQL and
 * Redis and returns `200` only when BOTH are reachable, otherwise `503`. CI/CD zero-downtime
 * deploys rely on the status code to decide whether the container may receive traffic. The
 * session middleware exempts this path, so a browser cookie can never make the probe touch
 * the Redis session store.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Actively pings PostgreSQL (via Prisma) and Redis. Returns 200 only when BOTH are ' +
      'reachable; 503 if either is down. The body reports each dependency so operators can ' +
      'see which one failed.',
  })
  @ApiOkResponse({
    description: 'Service is ready: the database and Redis are both reachable.',
    type: HealthResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description:
      'Service is not ready: the database and/or Redis is unreachable. Body carries the ' +
      'per-dependency breakdown.',
    type: HealthResponseDto,
  })
  check(): Promise<HealthResponseDto> {
    return this.health.check();
  }
}
