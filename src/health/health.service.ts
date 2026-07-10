import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthResponseDto } from './dto/health-response.dto';

/** Time-box for the DB probe so a hung connection can't stall the readiness check. */
const DB_PROBE_TIMEOUT_MS = 2000;

/**
 * Readiness logic for GET /api/v1/health.
 *
 * Unlike a bare liveness ping, this actively probes BOTH backing services the app cannot
 * serve traffic without — PostgreSQL (via Prisma) and Redis — and gates the HTTP status on
 * them. Both reachable → `200` with a per-dependency breakdown; either unreachable → a
 * `ServiceUnavailableException` (Nest maps to `503`) carrying the same breakdown, so a
 * CI/CD deploy or a load balancer can both detect *that* it is not ready and see *which*
 * dependency failed. Kept out of the controller so the controller stays a thin HTTP shell.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Probe both dependencies in parallel and resolve with the readiness snapshot.
   * @throws ServiceUnavailableException (503) when the DB and/or Redis is unreachable.
   */
  async check(): Promise<HealthResponseDto> {
    const [db, redis] = await Promise.all([this.probeDb(), this.probeRedis()]);

    const ready = db === 'up' && redis === 'up';
    const body: HealthResponseDto = {
      status: ready ? 'ok' : 'error',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      db,
      redis,
    };

    if (!ready) {
      this.logger.warn(`Readiness check failed. db=${db} redis=${redis}`);
      // Passing the object as-is makes it the verbatim 503 response body (Nest only wraps
      // string arguments), so operators get { status, db, redis } instead of a generic error.
      throw new ServiceUnavailableException(body);
    }

    return body;
  }

  /** Redis PING via the shared client's own time-boxed probe; never throws. */
  private async probeRedis(): Promise<'up' | 'down'> {
    return (await this.redis.isHealthy()) ? 'up' : 'down';
  }

  /** Time-bounded `SELECT 1` DB probe; never throws (a failure resolves to `'down'`). */
  private async probeDb(): Promise<'up' | 'down'> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('db probe timeout')),
        DB_PROBE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return 'up';
    } catch (error) {
      this.logger.warn(
        `DB probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'down';
    } finally {
      // The race is decided; the pending timer must not keep the event loop alive.
      if (timer) clearTimeout(timer);
    }
  }
}
