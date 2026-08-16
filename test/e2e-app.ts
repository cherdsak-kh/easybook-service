import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  TOMBSTONE_DEPARTMENT_NAME,
  TOMBSTONE_PERSONNEL_ROLE_NAME,
} from '../src/options/options.constants';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

/**
 * Boots the real application graph with the production middleware wiring (`configureApp`), so the
 * e2e specs exercise the same session / CSRF / validation pipeline `main.ts` builds.
 *
 * `rawBody: true` is required by `LineSignatureGuard`, exactly as in `main.ts`.
 *
 * `customise` lets a suite override a provider (the avatar spec swaps `R2StorageService` for a fake
 * — the e2e suites must NEVER touch real object storage, and CI has no R2 credentials). Everything
 * else stays the production graph.
 */
export async function createE2eApp(
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<INestApplication<App>> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customise) builder = customise(builder);
  const moduleFixture = await builder.compile();
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

/**
 * `SystemUser.departmentId`/`personnelRoleId` are REQUIRED FKs, so every fixture user needs a real
 * option row. Resolve-or-create a shared pair once per suite and reuse the ids.
 *
 * Deliberately NOT prefixed for deletion: these option rows are cheap, shared, and hard-deleting one
 * that a surviving fixture user still references would trip the `onDelete: Restrict` FK. Suites that
 * purge options do so by their own `e2e-opt-` prefix, which these names avoid.
 */
export async function ensureE2eOptions(
  prisma: PrismaService,
): Promise<{ departmentId: number; personnelRoleId: number }> {
  const name = 'E2E Fixture Option';
  const department =
    (await prisma.department.findFirst({
      where: { name, deletedAt: null },
      select: { id: true },
    })) ??
    (await prisma.department.create({ data: { name }, select: { id: true } }));
  const personnelRole =
    (await prisma.personnelRole.findFirst({
      where: { name, deletedAt: null },
      select: { id: true },
    })) ??
    (await prisma.personnelRole.create({
      data: { name },
      select: { id: true },
    }));
  return { departmentId: department.id, personnelRoleId: personnelRole.id };
}

/**
 * The TOMBSTONE rows an option delete re-points its holders to (OPT-FALLBACK-1).
 *
 * ⚠️ A suite that deletes an option NEEDS these, and their absence is a 500 by design — the
 * service refuses to strand live rows on a soft-deleted option rather than deleting anyway. In
 * production `create-super-admin` makes them; here the suite has to, because the e2e database is
 * migrated but never bootstrapped.
 *
 * Resolve-or-create by name and reserved-flag, exactly as `OptionsService.resolveTombstoneId`
 * looks them up, so a rename on one side fails loudly here instead of silently missing.
 */
export async function ensureTombstoneOptions(
  prisma: PrismaService,
): Promise<void> {
  // Spelled out per table rather than through a shared delegate: a union of the two (heavily
  // overloaded) Prisma delegates is not callable in TypeScript. Same fact `OptionsService` works
  // around with its hand-written `OptionDelegate`.
  const where = (name: string) => ({
    name,
    deletedAt: null,
    isSystemReserved: true,
  });

  const dept = await prisma.department.findFirst({
    where: where(TOMBSTONE_DEPARTMENT_NAME),
    select: { id: true },
  });
  if (!dept) {
    await prisma.department.create({
      data: { name: TOMBSTONE_DEPARTMENT_NAME, isSystemReserved: true },
    });
  }

  const role = await prisma.personnelRole.findFirst({
    where: where(TOMBSTONE_PERSONNEL_ROLE_NAME),
    select: { id: true },
  });
  if (!role) {
    await prisma.personnelRole.create({
      data: { name: TOMBSTONE_PERSONNEL_ROLE_NAME, isSystemReserved: true },
    });
  }
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
