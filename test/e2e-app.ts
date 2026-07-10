import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

/**
 * Boots the real application graph with the production middleware wiring (`configureApp`), so the
 * e2e specs exercise the same session / CSRF / validation pipeline `main.ts` builds.
 *
 * `rawBody: true` is required by `LineSignatureGuard`, exactly as in `main.ts`.
 */
export async function createE2eApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  return app;
}

export const prismaOf = (app: INestApplication): PrismaService =>
  app.get(PrismaService);
export const redisOf = (app: INestApplication): Redis =>
  app.get<Redis>(REDIS_CLIENT);

/** Waits until the shared Redis client is connected, so the first request never races the socket. */
export async function waitForRedis(
  redis: Redis,
  timeoutMs = 10_000,
): Promise<void> {
  if (redis.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error('Redis did not become ready — is it running? (DOCKER-1)'),
        ),
      timeoutMs,
    );
    redis.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Removes every login rate-limit counter. Sessions (`eb:sess:*`) are untouched. */
export async function clearThrottleCounters(redis: Redis): Promise<void> {
  const keys = await redis.keys('eb:throttle:*');
  if (keys.length > 0) await redis.del(...keys);
}

/** Test-fixture teardown. Raw SQL on purpose: the application code never hard-deletes a row. */
export async function purgeE2eUsers(
  prisma: PrismaService,
  prefix: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DELETE FROM system_users WHERE email LIKE '${prefix}%'`,
  );
}

export const readCookie = (
  res: request.Response,
  name: string,
): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
};

export const cookieValue = (cookie: string | undefined): string | undefined =>
  cookie?.split(';')[0]?.split('=')[1];
