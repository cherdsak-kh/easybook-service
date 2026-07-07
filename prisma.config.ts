import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 config: the CLI/Migrate reads the connection URL here (from DATABASE_URL).
// The runtime PrismaClient connects via a driver adapter — see src/prisma/prisma.service.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
