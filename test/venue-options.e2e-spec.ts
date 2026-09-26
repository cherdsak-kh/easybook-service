import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { VENUE_TYPE_CACHE_KEYS } from '../src/redis/cache-keys';
import { CACHE_KEY_PREFIX } from '../src/redis/redis.constants';
import { TOMBSTONE_VENUE_TYPE_NAME } from '../src/venue-types/venue-types.constants';
import {
  clearThrottleCounters,
  createE2eApp,
  ensureE2eOptions,
  hideLiveAmenities,
  prismaOf,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(120_000);

const SU_PREFIX = 'e2e-vosu-';
const ROW_PREFIX = 'e2e-vo-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface OptionBody {
  id: number;
  name: string;
  isSystemReserved: boolean;
  isFallback: boolean;
  holderCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Both curated venue tables under one spec, because most of the contract is shared and the
 * INTERESTING assertions are the places it is not: `/amenities` has no reserved rows, one cache
 * view, and a DELETE that answers 200 with a count instead of 204.
 */
describe('Venue options admin CRUD (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  const server = () => app.getHttpServer();

  const login = async (email: string): Promise<Session> => {
    const agent = request.agent(server());
    const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    await agent
      .post(url('/auth/system/login'))
      .set('x-csrf-token', token)
      .send({ email, password: PASSWORD })
      .expect(200);
    return { agent, token };
  };

  const purgeRows = async () => {
    // Venues first: `venues.venueTypeId` is `onDelete: Restrict`, so a leftover fixture venue from an
    // aborted run would otherwise block the venue_types purge below.
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM amenities WHERE "name" LIKE '${ROW_PREFIX}%'`,
    );
  };

  /**
   * The tombstone `/venue-types` DELETE resolves. Mirrors `ensureTombstoneOptions` for the personnel
   * tables — the same probe shape the seed script and the service both use (name + active +
   * reserved), so a row matching only on NAME never satisfies it.
   */
  const ensureVenueTypeTombstone = async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE venue_types SET "deletedAt" = NULL WHERE "name" = $1 AND "isSystemReserved" = true`,
      TOMBSTONE_VENUE_TYPE_NAME,
    );
    const existing = await prisma.venueType.findFirst({
      where: {
        name: TOMBSTONE_VENUE_TYPE_NAME,
        deletedAt: null,
        isSystemReserved: true,
      },
      select: { id: true },
    });
    if (!existing) {
      await prisma.venueType.create({
        data: { name: TOMBSTONE_VENUE_TYPE_NAME, isSystemReserved: true },
      });
    }
  };

  const seed = async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeRows();
    await ensureVenueTypeTombstone();
    const passwordHash = await new PasswordService().hash(PASSWORD);
    const base = {
      passwordHash,
      mustChangePassword: false,
      ...(await ensureE2eOptions(prisma)),
    };
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
    ] as Array<[string, SystemRole]>) {
      await prisma.systemUser.create({
        data: { email, firstName: 'E2E', lastName: role, role, ...base },
        select: { id: true },
      });
    }
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
  }, 60_000);

  beforeEach(async () => {
    await clearThrottleCounters(redis);
    await seed();
  });

  afterAll(async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeRows();
    await ensureVenueTypeTombstone();
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ── The contract both tables share ────────────────────────────────────────
  describe.each(['venue-types', 'amenities'] as const)('/%s', (resource) => {
    const base = `/${resource}`;
    const name = (suffix: string) => `${ROW_PREFIX}${resource}-${suffix}`;

    it('no session is 401', async () => {
      const anon = request.agent(server());
      const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
      const token = (csrf.body as { csrfToken: string }).csrfToken;
      await anon.get(url(base)).expect(401);
      await anon
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('x') })
        .expect(401);
    });

    it('VIEWER is 403 on read and on write — the backend is the boundary, not the hidden button', async () => {
      const { agent, token } = await login(VIEWER);
      await agent.get(url(base)).expect(403);
      await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('nope') })
        .expect(403);
    });

    it('create → rename → delete, and the name is REUSABLE afterwards', async () => {
      const { agent, token } = await login(ADMIN);

      const created = await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('a') })
        .expect(201);
      const row = created.body as OptionBody;
      expect(row.name).toBe(name('a'));
      // No venues exist anywhere yet, so every row honestly holds zero.
      expect(row.holderCount).toBe(0);

      await agent
        .patch(url(`${base}/${row.id}`))
        .set('x-csrf-token', token)
        .send({ name: name('b') })
        .expect(200);

      await agent
        .delete(url(`${base}/${row.id}`))
        .set('x-csrf-token', token)
        .expect(resource === 'amenities' ? 200 : 204);

      // A second delete is a 404, byte-identical to an unknown id.
      await agent
        .delete(url(`${base}/${row.id}`))
        .set('x-csrf-token', token)
        .expect(404);

      // The partial unique index is `WHERE deletedAt IS NULL`, so the retired name is free again.
      await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('b') })
        .expect(201);
    });

    it('an ACTIVE name collision is 409', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('dup') })
        .expect(201);
      await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('dup') })
        .expect(409);
    });
  });

  // ── /venue-types: everything that follows from having a reserved row ──────
  describe('/venue-types reserved row', () => {
    const tombstoneId = async (): Promise<number> => {
      const row = await prisma.venueType.findFirstOrThrow({
        where: {
          name: TOMBSTONE_VENUE_TYPE_NAME,
          deletedAt: null,
          isSystemReserved: true,
        },
        select: { id: true },
      });
      return row.id;
    };

    it('is INVISIBLE to an ADMIN and visible to a SUPER_ADMIN — and one does not poison the other through the cache', async () => {
      // Order matters: SUPER first, so the reserved view is the one already in Redis when ADMIN
      // asks. A cache key missing the `includeReserved` dimension would serve it straight back, and
      // a suite that logged in as one role only would never notice.
      const su = await login(SUPER);
      const suBody = (await su.agent.get(url('/venue-types')).expect(200))
        .body as OptionBody[];
      expect(suBody.some((r) => r.isFallback)).toBe(true);

      const ad = await login(ADMIN);
      const adBody = (await ad.agent.get(url('/venue-types')).expect(200))
        .body as OptionBody[];
      expect(adBody.some((r) => r.isSystemReserved)).toBe(false);
      expect(adBody.some((r) => r.name === TOMBSTONE_VENUE_TYPE_NAME)).toBe(
        false,
      );
    });

    it('is a 404 on PATCH and DELETE for a SUPER_ADMIN too — reserved is indistinguishable from never-existed', async () => {
      const id = await tombstoneId();
      const { agent, token } = await login(SUPER);
      await agent
        .patch(url(`/venue-types/${id}`))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}renamed` })
        .expect(404);
      await agent
        .delete(url(`/venue-types/${id}`))
        .set('x-csrf-token', token)
        .expect(404);
    });

    it('an ADMIN gets the SAME 404 body as for an id that never existed', async () => {
      const id = await tombstoneId();
      const { agent, token } = await login(ADMIN);
      const reserved = await agent
        .patch(url(`/venue-types/${id}`))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}x` })
        .expect(404);
      const unknown = await agent
        .patch(url('/venue-types/2147483000'))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}x` })
        .expect(404);
      expect(reserved.body).toEqual(unknown.body);
    });

    /**
     * Puts the dev DB back exactly as it was before the self-heal test: every venue on an
     * auto-created tombstone moves back to the ORIGINAL row, the auto-created rows are hard-deleted,
     * and only then is the original un-deleted (the other order collides on the active-name unique).
     *
     * ⚠️ Skipping this breaks the NEXT run, not this one: `ensureVenueTypeTombstone` un-deletes every
     * reserved row by name, and a leftover auto-created row would collide with the original there.
     */
    const restoreOriginalTombstone = async (
      originalId: number,
      fixtureVenueIds: string[],
    ) => {
      await prisma.venue.deleteMany({ where: { id: { in: fixtureVenueIds } } });
      const autoCreated = await prisma.venueType.findMany({
        where: {
          name: TOMBSTONE_VENUE_TYPE_NAME,
          isSystemReserved: true,
          id: { not: originalId },
        },
        select: { id: true },
      });
      const autoIds = autoCreated.map((row) => row.id);
      if (autoIds.length > 0) {
        // Not only this test's venues: the FK is Restrict, so ANY venue on the auto-created row
        // would block its removal.
        await prisma.venue.updateMany({
          where: { venueTypeId: { in: autoIds } },
          data: { venueTypeId: originalId },
        });
        await prisma.venueType.deleteMany({ where: { id: { in: autoIds } } });
      }
      await prisma.venueType.update({
        where: { id: originalId },
        data: { deletedAt: null },
      });
      await redis.del(
        ...VENUE_TYPE_CACHE_KEYS.map((k) => CACHE_KEY_PREFIX + k),
      );
    };

    it('AC-1…AC-4 · DELETE self-heals when the tombstone is missing: ONE reserved row is created, venues move to it, and the next delete reuses it', async () => {
      const originalId = await tombstoneId();
      const { agent, token } = await login(ADMIN);
      const createType = async (suffix: string): Promise<number> =>
        (
          (
            await agent
              .post(url('/venue-types'))
              .set('x-csrf-token', token)
              .send({ name: `${ROW_PREFIX}${suffix}` })
              .expect(201)
          ).body as OptionBody
        ).id;
      const firstId = await createType('heal-1');
      const secondId = await createType('heal-2');
      // One venue under each, so the re-point is observable. Written directly: `/venues` is not
      // what this suite tests.
      const venueUnder = async (venueTypeId: number, suffix: string) =>
        (
          await prisma.venue.create({
            data: { name: `${ROW_PREFIX}${suffix}`, venueTypeId, capacity: 1 },
            select: { id: true },
          })
        ).id;
      const v1 = await venueUnder(firstId, 'heal-v1');
      const v2 = await venueUnder(secondId, 'heal-v2');
      const typeOf = async (venueId: string) =>
        (
          await prisma.venue.findUniqueOrThrow({
            where: { id: venueId },
            select: { venueTypeId: true },
          })
        ).venueTypeId;
      const activeTombstoneNamed = () =>
        prisma.venueType.findMany({
          where: { name: TOMBSTONE_VENUE_TYPE_NAME, deletedAt: null },
          select: { id: true, isSystemReserved: true },
        });

      // Simulate "migrated but never seeded". BY ID, so the restore can find exactly this row again;
      // raw SQL because no endpoint can retire a reserved row.
      await prisma.$executeRawUnsafe(
        `UPDATE venue_types SET "deletedAt" = NOW() WHERE id = $1`,
        originalId,
      );
      try {
        // AC-1 — the same success status as a seeded database, not 500.
        await agent
          .delete(url(`/venue-types/${firstId}`))
          .set('x-csrf-token', token)
          .expect(204);

        // AC-2 — exactly one active row carries the name, and it is the RESERVED one.
        const healed = await activeTombstoneNamed();
        expect(healed).toHaveLength(1);
        expect(healed[0].isSystemReserved).toBe(true);
        const healedId = healed[0].id;
        expect(healedId).not.toBe(originalId);

        // AC-3 — the venue moved to the new tombstone; the target is soft-deleted.
        expect(await typeOf(v1)).toBe(healedId);
        const target = await prisma.venueType.findUniqueOrThrow({
          where: { id: firstId },
          select: { deletedAt: true },
        });
        expect(target.deletedAt).not.toBeNull();

        // AC-4 — a second delete reuses that same row; no duplicate is minted.
        await agent
          .delete(url(`/venue-types/${secondId}`))
          .set('x-csrf-token', token)
          .expect(204);
        expect(await activeTombstoneNamed()).toEqual([
          { id: healedId, isSystemReserved: true },
        ]);
        expect(await typeOf(v2)).toBe(healedId);
      } finally {
        await restoreOriginalTombstone(originalId, [v1, v2]);
      }

      // The restore itself is part of the contract with the next run.
      expect(await activeTombstoneNamed()).toEqual([
        { id: originalId, isSystemReserved: true },
      ]);
    });
  });

  // ── /amenities: everything that follows from having NO reserved row ───────
  describe('/amenities', () => {
    it('shows a SUPER_ADMIN and an ADMIN byte-identical rows — the only curated table where that is true', async () => {
      const { agent: aAgent, token } = await login(ADMIN);
      await aAgent
        .post(url('/amenities'))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}same-for-all` })
        .expect(201);

      const su = await login(SUPER);
      const suBody = (await su.agent.get(url('/amenities')).expect(200))
        .body as OptionBody[];
      const adBody = (await aAgent.get(url('/amenities')).expect(200))
        .body as OptionBody[];
      expect(suBody).toEqual(adBody);
    });

    it('DELETE answers 200 with releasedVenueCount, not 204', async () => {
      const { agent, token } = await login(ADMIN);
      const created = await agent
        .post(url('/amenities'))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}counted` })
        .expect(201);
      const id = (created.body as OptionBody).id;

      const deleted = await agent
        .delete(url(`/amenities/${id}`))
        .set('x-csrf-token', token)
        .expect(200);
      // 0 because no venues exist at all — the true answer, not a stub. Becomes the real number of
      // released ticks when `VenueAmenity` lands (VENUE-1).
      expect(deleted.body).toEqual({ releasedVenueCount: 0 });
    });

    it('never reports a row as reserved or as a fallback', async () => {
      const { agent, token } = await login(SUPER);
      const created = await agent
        .post(url('/amenities'))
        .set('x-csrf-token', token)
        .send({ name: `${ROW_PREFIX}plain` })
        .expect(201);
      const row = created.body as OptionBody;
      expect(row.isSystemReserved).toBe(false);
      expect(row.isFallback).toBe(false);
    });

    it('may be emptied completely — unlike the FK-backed tables, an empty amenity list breaks nothing', async () => {
      const { agent, token } = await login(SUPER);
      // The real amenities leave by raw UPDATE and come back by id (see `hideLiveAmenities`): the
      // DELETE route would also strip them off every venue, for good. What goes through the API is
      // this suite's own rows — at least one, so the loop can never pass by doing nothing.
      const restore = await hideLiveAmenities(prisma, redis, ROW_PREFIX);
      try {
        await agent
          .post(url('/amenities'))
          .set('x-csrf-token', token)
          .send({ name: `${ROW_PREFIX}last` })
          .expect(201);
        const before = (await agent.get(url('/amenities')).expect(200))
          .body as OptionBody[];
        expect(before.length).toBeGreaterThan(0);
        for (const row of before) {
          await agent
            .delete(url(`/amenities/${row.id}`))
            .set('x-csrf-token', token)
            .expect(200);
        }
        const after = (await agent.get(url('/amenities')).expect(200))
          .body as OptionBody[];
        expect(after).toEqual([]);
      } finally {
        await restore();
      }
    });
  });

  // ── The rule that keeps RBAC out of option logic (mirrors AC-X3) ──────────
  it('AC-X — neither venue module mentions SystemRole outside @Roles()', () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        for (const raw of readFileSync(path, 'utf8').split('\n')) {
          const line = raw.trim();
          if (!line.includes('SystemRole')) continue;
          // Comments discuss the rule — this very file's guidance does — and a scanner that reads
          // them reports the documentation as the violation. First version of this test did exactly
          // that and failed on the sentence explaining itself.
          if (
            line.startsWith('*') ||
            line.startsWith('//') ||
            line.startsWith('/*')
          ) {
            continue;
          }
          // EXACTLY TWO legitimate forms: the import, and the controller's decorator.
          //
          // ⚠️ Do NOT widen this to "any line containing `SystemRole.`" — that is what the first
          // draft did, and it would wave through `if (user.role === SystemRole.ADMIN)`, which is
          // precisely the privilege decision this check exists to keep out of option logic.
          if (line === "import { SystemRole } from '@prisma/client';") continue;
          if (line.startsWith('@Roles(')) continue;
          offenders.push(`${path}: ${line}`);
        }
      }
    };
    walk(join('src', 'venue-types'));
    walk(join('src', 'amenities'));

    expect(offenders).toEqual([]);
  });
});
