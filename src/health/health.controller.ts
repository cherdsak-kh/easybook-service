import { Controller, Get, Logger } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { HealthResponseDto } from './dto/health-response.dto';

/** Operational health probe. Route: GET /api/v1/health */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOkResponse({
    description: 'Service is up (and whether the database is reachable).',
    type: HealthResponseDto,
  })
  async check(): Promise<HealthResponseDto> {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      db: await this.probeDb(),
    };
  }

  /** Lightweight DB liveness probe; time-bounded and never throws. */
  private async probeDb(): Promise<'up' | 'down'> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('db probe timeout')), 2000),
    );
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return 'up';
    } catch (error) {
      this.logger.warn(
        `DB probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'down';
    }
  }
}
