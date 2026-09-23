import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { SerialQueryClient } from './serial-query-client';

/**
 * Prisma client as a Nest provider. Prisma 7 connects via a driver adapter
 * (@prisma/adapter-pg) fed the DATABASE_URL. Connection is attempted on init but
 * failures are logged rather than thrown, so the app still boots when the DB is
 * unreachable (readiness is surfaced by the /health endpoint instead).
 *
 * The adapter still builds and owns its pool (and ends it on `$disconnect`); `Client` is a plain
 * pg `PoolConfig` option that makes that pool hand out {@link SerialQueryClient}s, so a
 * transaction's relation loads never overlap on one connection. See that file.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        Client: SerialQueryClient,
      }),
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
