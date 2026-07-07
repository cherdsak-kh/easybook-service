import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma client as a Nest provider. Prisma 7 connects via a driver adapter
 * (@prisma/adapter-pg) fed the DATABASE_URL. Connection is attempted on init but
 * failures are logged rather than thrown, so the app still boots when the DB is
 * unreachable (readiness is surfaced by the /health endpoint instead).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }

  onModuleInit(): void {
    // Fire-and-forget: never block app startup on the DB. Queries connect lazily,
    // and readiness is reported by /health.
    this.$connect()
      .then(() => this.logger.log('Connected to the database.'))
      .catch((error: unknown) =>
        this.logger.warn(
          `Database connection failed (continuing without DB): ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
