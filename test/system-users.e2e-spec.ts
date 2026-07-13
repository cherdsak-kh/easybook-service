import type { INestApplication } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  clearThrottleCounters,
  createE2eApp,
  prismaOf,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(120_000);

const PREFIX = 'e2e-su-';
const PASSWORD = 'e2e-correct-horse-battery';

const SUPER = `${PREFIX}super@easybook.local`;
const SUPER_2 = `${PREFIX}super2@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const ADMIN_2 = `${PREFIX}admin2@easybook.local`;
const STAFF = `${PREFIX}staff@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

describe('SystemUsers CRUD authz surface (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  const ids: Record<string, string> = {};
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

  /** Re-creates the fixture rows so each test starts from a known world. */
  const seed = async () => {
    await purgeE2eUsers(prisma, PREFIX);
    const passwordHash = await new PasswordService().hash(PASSWORD);
    const base = { passwordHash, position: 'Director', department: 'IT' };

    for (const [email, firstName, lastName, role] of [
      [SUPER, 'E2E', 'Super', SystemRole.SUPER_ADMIN],
      [SUPER_2, 'E2E', 'Super Two', SystemRole.SUPER_ADMIN],
      [ADMIN, 'E2E', 'Admin', SystemRole.ADMIN],
      [ADMIN_2, 'E2E', 'Admin Two', SystemRole.ADMIN],
      [STAFF, 'E2E', 'Staff', SystemRole.STAFF],
    ] as Array<[string, string, string, SystemRole]>) {
      const created = await prisma.systemUser.create({
        data: { email, firstName, lastName, role, ...base },
        select: { id: true },
      });
      ids[email] = created.id;
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
    await purgeE2eUsers(prisma, PREFIX);
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ─────────────────────── unauthenticated / STAFF ───────────────────────

  it('AC-42 — with no session, all six /system-users routes return 401', async () => {
    const anon = request.agent(server());
    const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    const id = ids[STAFF];

    await anon.get(url('/system-users')).expect(401);
    await anon.get(url(`/system-users/${id}`)).expect(401);
    await anon
      .post(url('/system-users'))
      .set('x-csrf-token', token)
      .send({})
      .expect(401);
    await anon
      .patch(url(`/system-users/${id}`))
      .set('x-csrf-token', token)
      .send({ firstName: 'X' })
      .expect(401);
    await anon
      .delete(url(`/system-users/${id}`))
      .set('x-csrf-token', token)
      .expect(401);
    await anon
      .post(url(`/system-users/${id}/restore`))
      .set('x-csrf-token', token)
      .expect(401);
  });

  it('AC-45 — STAFF gets 403 on every /system-users route, with no DB read', async () => {
    const { agent, token } = await login(STAFF);
    const id = ids[ADMIN];

    await agent.get(url('/system-users')).expect(403);
    await agent.get(url(`/system-users/${id}`)).expect(403);
    await agent
      .patch(url(`/system-users/${id}`))
      .set('x-csrf-token', token)
      .send({ firstName: 'X' })
      .expect(403);
    await agent
      .delete(url(`/system-users/${id}`))
      .set('x-csrf-token', token)
      .expect(403);
    await agent
      .post(url(`/system-users/${id}/restore`))
      .set('x-csrf-token', token)
      .expect(403);

    // A STAFF caller cannot even distinguish a real id from an invented one.
    await agent.get(url('/system-users/does-not-exist')).expect(403);
  });

  it('AC-45 — ADMIN gets 403 on DELETE and restore for any id, before the target is loaded', async () => {
    const { agent, token } = await login(ADMIN);

    await agent
      .delete(url(`/system-users/${ids[STAFF]}`))
      .set('x-csrf-token', token)
      .expect(403);
    await agent
      .delete(url('/system-users/invented-id'))
      .set('x-csrf-token', token)
      .expect(403);
    await agent
      .post(url(`/system-users/${ids[STAFF]}/restore`))
      .set('x-csrf-token', token)
      .expect(403);
  });

  // ─────────────────────────── list / read ───────────────────────────

  describe('GET /system-users', () => {
    it('AC-38 — returns the { data, meta } envelope with defaults page=1, limit=20', async () => {
      const { agent } = await login(ADMIN);
      const res = await agent.get(url('/system-users')).expect(200);

      const body = res.body as {
        data: unknown[];
        meta: Record<string, number>;
      };
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(20);
      expect(body.meta.total).toBeGreaterThanOrEqual(5);
      expect(body.meta.totalPages).toBe(Math.ceil(body.meta.total / 20));
      expect(JSON.stringify(body)).not.toContain('deletedAt');
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('AC-39 — limit=101, limit=0, page=0 and an unknown query param are each 400', async () => {
      const { agent } = await login(ADMIN);
      await agent.get(url('/system-users?limit=101')).expect(400);
      await agent.get(url('/system-users?limit=0')).expect(400);
      await agent.get(url('/system-users?page=0')).expect(400);
      await agent.get(url('/system-users?sort=name')).expect(400);
    });

    it('AC-39 — a page beyond the last is 200 with an empty data array and truthful meta', async () => {
      const { agent } = await login(ADMIN);
      const res = await agent.get(url('/system-users?page=9999')).expect(200);
      const body = res.body as { data: unknown[]; meta: { page: number } };
      expect(body.data).toEqual([]);
      expect(body.meta.page).toBe(9999);
    });

    it('AC-41 — GET /:id on an unknown id is a 404 identical to the soft-deleted case', async () => {
      const sa = await login(SUPER);
      await sa.agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', sa.token)
        .expect(204);

      const unknown = await sa.agent
        .get(url('/system-users/never-existed'))
        .expect(404);
      const deleted = await sa.agent
        .get(url(`/system-users/${ids[STAFF]}`))
        .expect(404);

      expect(deleted.body).toEqual(unknown.body);
      expect(JSON.stringify(deleted.body)).not.toContain('deletedAt');
    });

    it('AC-40 — a soft-deleted user disappears from data and from meta.total', async () => {
      const sa = await login(SUPER);
      const before = (
        await sa.agent.get(url('/system-users?limit=100')).expect(200)
      ).body as {
        data: Array<{ email: string }>;
        meta: { total: number };
      };

      await sa.agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', sa.token)
        .expect(204);

      const after = (
        await sa.agent.get(url('/system-users?limit=100')).expect(200)
      ).body as {
        data: Array<{ email: string }>;
        meta: { total: number };
      };
      expect(after.meta.total).toBe(before.meta.total - 1);
      expect(after.data.map((u) => u.email)).not.toContain(STAFF);
    });
  });

  // ─────────────────────────── create ───────────────────────────

  describe('POST /system-users', () => {
    const newUser = {
      email: `${PREFIX}created@easybook.local`,
      password: 'a-long-enough-password',
      firstName: 'Created',
      lastName: 'User',
      position: 'Teacher',
      department: 'Computer Science',
    };

    it('AC-24 — a SUPER_ADMIN creates a user (201), stamped with createdById', async () => {
      const { agent, token } = await login(SUPER);
      const res = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send(newUser)
        .expect(201);

      expect(res.body).toMatchObject({
        email: newUser.email,
        role: SystemRole.STAFF,
        isActive: true,
        lineUserId: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');

      const row = await prisma.systemUser.findUnique({
        where: { email: newUser.email },
        select: { createdById: true },
      });
      expect(row?.createdById).toBe(ids[SUPER]);
    });

    it('AC-25 — an ADMIN creating a user → 403', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send(newUser)
        .expect(403);
    });

    it('AC-26 — a duplicate email in any casing → 409, and no second row is written', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send(newUser)
        .expect(201);

      const res = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({ ...newUser, email: newUser.email.toUpperCase() })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'A system user with this email already exists.',
      );

      await expect(
        prisma.systemUser.count({ where: { email: newUser.email } }),
      ).resolves.toBe(1);
    });

    it('AC-35 — a lineUserId in the body → 400 (forbidNonWhitelisted)', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({ ...newUser, lineUserId: 'clx000000000000000000000' })
        .expect(400);
    });

    it('AC-37 — a missing position/department, or a non-https avatar URL, is a 400', async () => {
      const { agent, token } = await login(SUPER);
      const post = (body: Record<string, unknown>) =>
        agent.post(url('/system-users')).set('x-csrf-token', token).send(body);

      await post({ ...newUser, position: undefined }).expect(400);
      await post({ ...newUser, department: undefined }).expect(400);
      await post({
        ...newUser,
        profilePictureUrl: 'http://cdn.x.com/a.jpg',
      }).expect(400);
      await post({
        ...newUser,
        profilePictureUrl: 'javascript:alert(1)',
      }).expect(400);
    });

    it('rejects a password shorter than 12 characters', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({ ...newUser, password: 'short' })
        .expect(400);
    });
  });

  // ─────────────────────────── patch ───────────────────────────

  describe('PATCH /system-users/:id', () => {
    it('AC-43 — an ADMIN patching an ADMIN or a SUPER_ADMIN target → 403, and no row is written', async () => {
      const { agent, token } = await login(ADMIN);

      for (const target of [ADMIN_2, SUPER]) {
        await agent
          .patch(url(`/system-users/${ids[target]}`))
          .set('x-csrf-token', token)
          .send({ firstName: 'Renamed' })
          .expect(403);

        const row = await prisma.systemUser.findUnique({
          where: { id: ids[target] },
          select: { firstName: true },
        });
        expect(row?.firstName).not.toBe('Renamed');
      }
    });

    it('AC-43 — an ADMIN patching themself → 403 (their own target is an ADMIN)', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`/system-users/${ids[ADMIN]}`))
        .set('x-csrf-token', token)
        .send({ firstName: 'Self Rename' })
        .expect(403);
    });

    it('AC-44 — an ADMIN sending any valid role value → 403, including a no-op role on a STAFF target', async () => {
      const { agent, token } = await login(ADMIN);

      for (const role of Object.values(SystemRole)) {
        await agent
          .patch(url(`/system-users/${ids[STAFF]}`))
          .set('x-csrf-token', token)
          .send({ role })
          .expect(403);
      }

      const row = await prisma.systemUser.findUnique({
        where: { id: ids[STAFF] },
        select: { role: true },
      });
      expect(row?.role).toBe(SystemRole.STAFF);
    });

    it('AC-62 — an ADMIN sending `{"role": null}` gets 400 at validation, not 403 at the policy', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ role: null })
        .expect(400);
    });

    it('an ADMIN may patch a STAFF target, including isActive', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ firstName: 'Renamed Staff', isActive: false })
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({
            firstName: 'Renamed Staff',
            isActive: false,
          });
        });
    });

    it('AC-46 / AC-47 — nobody may patch their own role or isActive, SUPER_ADMIN included', async () => {
      const { agent, token } = await login(SUPER);
      const self = url(`/system-users/${ids[SUPER]}`);

      await agent
        .patch(self)
        .set('x-csrf-token', token)
        .send({ role: SystemRole.STAFF })
        .expect(403);
      await agent
        .patch(self)
        .set('x-csrf-token', token)
        .send({ isActive: false })
        .expect(403);
      await agent
        .patch(self)
        .set('x-csrf-token', token)
        .send({ isActive: true })
        .expect(403);

      const row = await prisma.systemUser.findUnique({
        where: { id: ids[SUPER] },
        select: { role: true, isActive: true },
      });
      expect(row).toEqual({ role: SystemRole.SUPER_ADMIN, isActive: true });
    });

    it('AC-49 — a SUPER_ADMIN may patch their own profile fields → 200', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(url(`/system-users/${ids[SUPER]}`))
        .set('x-csrf-token', token)
        .send({
          firstName: 'Ada',
          position: 'Director',
          department: 'IT',
          phoneNumber: '02-123-4567',
        })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            firstName: 'Ada',
            phoneNumber: '02-123-4567',
          }),
        );
    });

    it('AC-60 — a forbidden key is a 400', async () => {
      const { agent, token } = await login(SUPER);
      const patch = (body: Record<string, unknown>) =>
        agent
          .patch(url(`/system-users/${ids[STAFF]}`))
          .set('x-csrf-token', token)
          .send(body);

      for (const key of [
        'lineUserId',
        'password',
        'passwordHash',
        'email',
        'deletedAt',
        'createdById',
        'id',
        'lastLoginAt',
        'createdAt',
        'updatedAt',
      ]) {
        await patch({ firstName: 'X', [key]: 'anything' }).expect(400);
      }
    });

    it('AC-61 — an empty body is a 400 and updatedAt is not bumped', async () => {
      const { agent, token } = await login(SUPER);
      const before = await prisma.systemUser.findUnique({
        where: { id: ids[STAFF] },
        select: { updatedAt: true },
      });

      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({})
        .expect(400);

      const after = await prisma.systemUser.findUnique({
        where: { id: ids[STAFF] },
        select: { updatedAt: true },
      });
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    });

    it('AC-62 — an explicit null clears the nullable columns; null on a NOT NULL column is 400', async () => {
      const { agent, token } = await login(SUPER);
      const target = url(`/system-users/${ids[STAFF]}`);

      await agent
        .patch(target)
        .set('x-csrf-token', token)
        .send({
          phoneNumber: '02-999-9999',
          profilePictureUrl: 'https://cdn.x.com/a.jpg',
        })
        .expect(200);

      await agent
        .patch(target)
        .set('x-csrf-token', token)
        .send({ phoneNumber: null, profilePictureUrl: null })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            phoneNumber: null,
            profilePictureUrl: null,
          }),
        );

      await agent
        .patch(target)
        .set('x-csrf-token', token)
        .send({ firstName: null })
        .expect(400);
    });

    it('PATCH requires a CSRF token', async () => {
      const { agent } = await login(SUPER);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .send({ firstName: 'X' })
        .expect(403);
    });

    it('AC-53 — PATCH on a soft-deleted id → 404', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .expect(204);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ firstName: 'X' })
        .expect(404);
    });
  });

  // ────────────────────── delete / restore / burn ──────────────────────

  describe('DELETE + restore', () => {
    it('AC-48 — deleting your own id → 403, any role', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .delete(url(`/system-users/${ids[SUPER]}`))
        .set('x-csrf-token', token)
        .expect(403);

      const row = await prisma.systemUser.findUnique({
        where: { id: ids[SUPER] },
        select: { deletedAt: true },
      });
      expect(row?.deletedAt).toBeNull();
    });

    it('AC-52 — DELETE returns exactly 204 with an empty body, and the physical row survives', async () => {
      const { agent, token } = await login(SUPER);
      const physicalRows = () =>
        prisma.systemUser.count({ where: { email: { startsWith: PREFIX } } });
      const countBefore = await physicalRows();

      const res = await agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .expect(204);
      expect(res.text).toBe('');
      expect(res.body).toEqual({});

      // Soft delete: `SELECT count(*)` is unchanged — the row is still physically present.
      await expect(physicalRows()).resolves.toBe(countBefore);
      const row = await prisma.systemUser.findUnique({
        where: { id: ids[STAFF] },
        select: { deletedAt: true },
      });
      expect(row?.deletedAt).not.toBeNull();
    });

    it('AC-53 — a second DELETE, and a DELETE of an id that never existed, are byte-identical 404s', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .expect(204);

      const second = await agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .expect(404);
      const never = await agent
        .delete(url('/system-users/never-existed'))
        .set('x-csrf-token', token)
        .expect(404);

      expect(second.body).toEqual(never.body);
      expect(second.body).toMatchObject({
        statusCode: 404,
        message: 'System user not found.',
      });
    });

    it('AC-54 — after deletion, re-creating that email is a 409 forever (the burn)', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .expect(204);

      const res = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({
          email: STAFF,
          password: 'a-long-enough-password',
          firstName: 'Impostor',
          lastName: 'User',
          position: 'p',
          department: 'd',
        })
        .expect(409);

      // The message must not reveal that the colliding row is soft-deleted.
      expect((res.body as { message: string }).message).toBe(
        'A system user with this email already exists.',
      );
    });

    it('AC-55 — restore returns exactly 200, clears the deletion, and the user reappears in the list', async () => {
      const { agent, token } = await login(SUPER);
      const before = await prisma.systemUser.findUnique({
        where: { id: ids[STAFF] },
      });

      await agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .expect(204);
      const res = await agent
        .post(url(`/system-users/${ids[STAFF]}/restore`))
        .set('x-csrf-token', token)
        .expect(200);

      expect(res.body).toMatchObject({
        id: ids[STAFF],
        email: STAFF,
        role: SystemRole.STAFF,
      });
      expect(JSON.stringify(res.body)).not.toContain('deletedAt');

      const after = await prisma.systemUser.findUnique({
        where: { id: ids[STAFF] },
      });
      expect(after?.deletedAt).toBeNull();
      expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
      expect(after?.createdById).toBe(before?.createdById);
      expect(after?.isActive).toBe(before?.isActive);
      expect(after?.passwordHash).toBe(before?.passwordHash); // the original password still works

      const list = (await agent.get(url('/system-users?limit=100')).expect(200))
        .body as {
        data: Array<{ email: string }>;
      };
      expect(list.data.map((u) => u.email)).toContain(STAFF);
    });

    it('AC-55 — a user suspended before deletion comes back suspended (the flags are orthogonal)', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ isActive: false })
        .expect(200);
      await agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .expect(204);

      const res = await agent
        .post(url(`/system-users/${ids[STAFF]}/restore`))
        .set('x-csrf-token', token)
        .expect(200);
      expect(res.body).toMatchObject({ isActive: false });
    });

    it('AC-56 — restore on a live row → 409; on an unknown id → 404; as an ADMIN → 403', async () => {
      const sa = await login(SUPER);
      const live = await sa.agent
        .post(url(`/system-users/${ids[STAFF]}/restore`))
        .set('x-csrf-token', sa.token)
        .expect(409);
      expect((live.body as { message: string }).message).toBe(
        'User is not deleted.',
      );

      await sa.agent
        .post(url('/system-users/never-existed/restore'))
        .set('x-csrf-token', sa.token)
        .expect(404);

      const ad = await login(ADMIN);
      await ad.agent
        .post(url(`/system-users/${ids[STAFF]}/restore`))
        .set('x-csrf-token', ad.token)
        .expect(403);
    });

    it('a SUPER_ADMIN may delete another SUPER_ADMIN while one active SUPER_ADMIN remains', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .delete(url(`/system-users/${ids[SUPER_2]}`))
        .set('x-csrf-token', token)
        .expect(204);
    });
  });

  // ────────────────── session invalidation via CRUD (D-9) ──────────────────

  describe('session invalidation', () => {
    it('AC-58 — a user soft-deleted mid-session is rejected with 401 on their very next request', async () => {
      const victim = await login(STAFF);
      await victim.agent.get(url('/auth/system/me')).expect(200);

      const sa = await login(SUPER);
      await sa.agent
        .delete(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', sa.token)
        .expect(204);

      await victim.agent.get(url('/auth/system/me')).expect(401);
    });

    it('AC-27 — a user deactivated mid-session is rejected on their next request, not at expiry', async () => {
      const victim = await login(STAFF);
      const sa = await login(SUPER);
      await sa.agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', sa.token)
        .send({ isActive: false })
        .expect(200);

      await victim.agent.get(url('/auth/system/me')).expect(401);
    });

    it('AC-28 / AC-59 — a SUPER_ADMIN demoted mid-session loses /system-users but keeps /me', async () => {
      const victim = await login(SUPER_2);
      await victim.agent.get(url('/system-users')).expect(200);

      const sa = await login(SUPER);
      await sa.agent
        .patch(url(`/system-users/${ids[SUPER_2]}`))
        .set('x-csrf-token', sa.token)
        .send({ role: SystemRole.STAFF })
        .expect(200);

      await victim.agent.get(url('/system-users')).expect(403);
      await victim.agent.get(url('/auth/system/me')).expect(200);
    });
  });
});
