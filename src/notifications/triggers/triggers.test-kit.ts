import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import type { NotificationsService } from '../notifications.service';
import { AdminNotificationTriggers } from './admin-notification-triggers.service';

/**
 * Unit-test factory for {@link AdminNotificationTriggers} (design §5.2). NOT part of the production
 * build — excluded via `tsconfig.build.json`'s `exclude`, so a `jest.fn()`/`jest.spyOn` reference
 * here can never ship.
 */

/**
 * A REAL `AdminNotificationTriggers` with `enabled = false` and inert dependencies. Every public
 * method returns immediately without touching Prisma, Redis or `NotificationsService.create` — safe
 * to hand to any existing spec that merely needs to satisfy a constructor.
 */
export function disabledTriggers(): AdminNotificationTriggers {
  const inert = {} as unknown;
  return new AdminNotificationTriggers(
    inert as NotificationsService,
    inert as PrismaService,
    inert as RedisService,
    false,
  );
}

/**
 * A REAL `AdminNotificationTriggers` with `enabled = true`, wired to a `NotificationsService.create`
 * that always rejects — the AC-2 fail-safe fixture. `redis.claimOnce` resolves `true` so C1/C5 are
 * never suppressed by the dedupe seam in a spec that is not testing dedupe. `prisma` is the caller's
 * own mock (it must supply whatever `findUnique`/`findMany` the hook under test reads).
 */
export function rejectingTriggers(prisma: PrismaService) {
  const create = jest.fn().mockRejectedValue(new Error('boom'));
  const notifications = { create } as unknown as NotificationsService;
  const redis = {
    claimOnce: jest.fn().mockResolvedValue(true),
  } as unknown as RedisService;
  const warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  const triggers = new AdminNotificationTriggers(
    notifications,
    prisma,
    redis,
    true,
  );
  return { triggers, create, warn };
}
