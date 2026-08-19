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
  ensureE2eOptions,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(120_000);

const PREFIX = 'e2e-su-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${PREFIX}super@easybook.local`;
const SUPER_2 = `${PREFIX}super2@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const ADMIN_2 = `${PREFIX}admin2@easybook.local`;
const VIEWER = `${PREFIX}staff@easybook.local`;

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
    // mustChangePassword: false — these fixtures are already-onboarded users. The model default
    // is TRUE (deny by default), so omitting it would gate every fixture into a 403.
    const base = {
      passwordHash,
      mustChangePassword: false,
      ...(await ensureE2eOptions(prisma)),
    };

    for (const [email, firstName, lastName, role] of [
      [SUPER, 'E2E', 'Super', SystemRole.SUPER_ADMIN],
      [SUPER_2, 'E2E', 'Super Two', SystemRole.SUPER_ADMIN],
      [ADMIN, 'E2E', 'Admin', SystemRole.ADMIN],
      [ADMIN_2, 'E2E', 'Admin Two', SystemRole.ADMIN],
      [VIEWER, 'E2E', 'Staff', SystemRole.VIEWER],
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

  // ─────────────────────── unauthenticated / VIEWER ───────────────────────

  it('AC-42 — with no session, all six /system-users routes return 401', async () => {
    const anon = request.agent(server());
    const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    const id = ids[VIEWER];

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

  /*
   * AC-45, as amended 19 ส.ค. 2569 (PO). It used to read "VIEWER gets 403 on EVERY /system-users
   * route"; the READ half was wrong against the design — the prototype's role table for
   * เจ้าหน้าที่ระบบ marks เห็นรายชื่อ + รายละเอียด ✅ for all three roles, and the app deliberately
   * keeps that destination out of `VIEWER_DENY`. The WRITE half is the part that carries D-2 and it
   * is unchanged, so it is asserted here in full.
   */
  it('AC-45 — VIEWER may READ the directory', async () => {
    const { agent } = await login(VIEWER);

    await agent.get(url('/system-users')).expect(200);
    await agent.get(url(`/system-users/${ids[ADMIN]}`)).expect(200);

    // The cost of that read, stated: existence is no longer hidden from a VIEWER. A real id answers
    // 200 and an invented one 404 — which the directory they just listed would have told them anyway.
    await agent.get(url('/system-users/does-not-exist')).expect(404);
  });

  it('AC-45 — VIEWER still gets 403 on every /system-users WRITE', async () => {
    const { agent, token } = await login(VIEWER);
    const id = ids[ADMIN];

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
    await agent
      .post(url(`/system-users/${id}/reset-password`))
      .set('x-csrf-token', token)
      .expect(403);
    await agent
      .post(url('/system-users'))
      .set('x-csrf-token', token)
      .send({
        email: `${PREFIX}nope@easybook.local`,
        firstName: 'N',
        lastName: 'O',
        role: 'VIEWER',
        departmentId: 1,
        personnelRoleId: 1,
      })
      .expect(403);
  });

  it('`status=deleted` stays SUPER_ADMIN-only even though the collection is now readable', async () => {
    const { agent } = await login(VIEWER);
    await agent.get(url('/system-users?status=deleted')).expect(403);
  });

  it('AC-45 — ADMIN gets 403 on DELETE and restore for any id, before the target is loaded', async () => {
    const { agent, token } = await login(ADMIN);

    await agent
      .delete(url(`/system-users/${ids[VIEWER]}`))
      .set('x-csrf-token', token)
      .expect(403);
    await agent
      .delete(url('/system-users/invented-id'))
      .set('x-csrf-token', token)
      .expect(403);
    await agent
      .post(url(`/system-users/${ids[VIEWER]}/restore`))
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
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', sa.token)
        .expect(204);

      const unknown = await sa.agent
        .get(url('/system-users/never-existed'))
        .expect(404);
      const deleted = await sa.agent
        .get(url(`/system-users/${ids[VIEWER]}`))
        .expect(404);

      expect(deleted.body).toEqual(unknown.body);
      expect(JSON.stringify(deleted.body)).not.toContain('deletedAt');
    });

    it('T19 — a SOFT-DELETED creator still resolves on GET /:id: createdById is HISTORY (DD-4)', async () => {
      // The one test that would actually catch the failure mode this design warns about — resolving
      // the creator with a second `findFirst({ id, deletedAt: null })`, which is the correct idiom
      // everywhere else in this service and is WRONG here. The relation traversal must follow the
      // FK unconditionally, so a deleted creator's name survives on every row they created.
      const creator = await login(SUPER_2);
      const email = `${PREFIX}has-creator@easybook.local`;
      const created = await creator.agent
        .post(url('/system-users'))
        .set('x-csrf-token', creator.token)
        .send({
          email,
          firstName: 'Has',
          lastName: 'Creator',
          ...(await ensureE2eOptions(prisma)),
        })
        .expect(201);
      const createdId = (created.body as { id: string }).id;
      expect((created.body as { createdBy: { id: string } }).createdBy.id).toBe(
        ids[SUPER_2],
      );

      const sa = await login(SUPER);
      await sa.agent
        .delete(url(`/system-users/${ids[SUPER_2]}`))
        .set('x-csrf-token', sa.token)
        .expect(204);

      const res = await sa.agent
        .get(url(`/system-users/${createdId}`))
        .expect(200);
      expect((res.body as { createdBy: unknown }).createdBy).toEqual({
        id: ids[SUPER_2],
        firstName: 'E2E',
        lastName: 'Super Two',
      });
      // The deleted creator's own row is gone from every identity read, yet its name still resolves
      // as history above. Those two facts must hold simultaneously.
      await sa.agent.get(url(`/system-users/${ids[SUPER_2]}`)).expect(404);
      expect(JSON.stringify(res.body)).not.toContain('deletedAt');
    });

    it('T19 — createdBy is null for a row seeded outside the API (the first SUPER_ADMIN case)', async () => {
      // The e2e fixtures are inserted directly, so `createdById` is null — the same shape as the
      // seeded first SUPER_ADMIN, which is exactly why the DTO field is nullable.
      const { agent } = await login(SUPER);
      const res = await agent
        .get(url(`/system-users/${ids[VIEWER]}`))
        .expect(200);
      expect((res.body as { createdBy: unknown }).createdBy).toBeNull();
      expect(typeof (res.body as { updatedAt: unknown }).updatedAt).toBe(
        'string',
      );
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
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', sa.token)
        .expect(204);

      const after = (
        await sa.agent.get(url('/system-users?limit=100')).expect(200)
      ).body as {
        data: Array<{ email: string }>;
        meta: { total: number };
      };
      expect(after.meta.total).toBe(before.meta.total - 1);
      expect(after.data.map((u) => u.email)).not.toContain(VIEWER);
    });
  });

  // ─────────────────────────── create ───────────────────────────

  describe('POST /system-users', () => {
    // No `password`: the SERVER issues a temp password now. `position`/`department` are FK ids.
    let newUser: Record<string, unknown>;
    beforeEach(async () => {
      const { departmentId, personnelRoleId } = await ensureE2eOptions(prisma);
      newUser = {
        email: `${PREFIX}created@easybook.local`,
        firstName: 'Created',
        lastName: 'User',
        departmentId,
        personnelRoleId,
      };
    });

    it('AC-24 — a SUPER_ADMIN creates a user (201), stamped with createdById', async () => {
      const { agent, token } = await login(SUPER);
      const res = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send(newUser)
        .expect(201);

      expect(res.body).toMatchObject({
        email: newUser.email,
        role: SystemRole.VIEWER,
        isActive: true,
        lineUserId: null,
        mustChangePassword: true, // the server issued a temp password
      });
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');

      const row = await prisma.systemUser.findUnique({
        where: { email: newUser.email as string },
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
        .send({ ...newUser, email: (newUser.email as string).toUpperCase() })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'A system user with this email already exists.',
      );

      await expect(
        prisma.systemUser.count({ where: { email: newUser.email as string } }),
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

    it('AC-37 — a missing personnelRoleId/departmentId, or a non-https avatar URL, is a 400', async () => {
      const { agent, token } = await login(SUPER);
      const post = (body: Record<string, unknown>) =>
        agent.post(url('/system-users')).set('x-csrf-token', token).send(body);

      await post({ ...newUser, personnelRoleId: undefined }).expect(400);
      await post({ ...newUser, departmentId: undefined }).expect(400);
      await post({
        ...newUser,
        profilePictureUrl: 'http://cdn.x.com/a.jpg',
      }).expect(400);
      await post({
        ...newUser,
        profilePictureUrl: 'javascript:alert(1)',
      }).expect(400);
    });

    it('AC-B7 — `password` is absent from the DTO, so an admin-chosen password is a 400', async () => {
      // It would be a second credential path that bypasses the forced-reset gate entirely.
      const { agent, token } = await login(SUPER);
      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({ ...newUser, password: 'a-long-enough-password' })
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

    // INVERTED on 2026-07-26 (SELF-PROFILE-2, 02_design_log.md §1). This previously asserted 403
    // under the name 'AC-43 — an ADMIN patching themself → 403 (their own target is an ADMIN)'.
    // NOTE for whoever edits the fixtures: PATCH /system-users/:id is NOT exempt from the
    // forced-reset gate, so `mustChangePassword: false` on the seed (see `seed()`) is what keeps
    // these from being 403s for the wrong reason.
    it('E1 — an ADMIN patches their OWN row → 200, and the new department is reflected', async () => {
      const { agent, token } = await login(ADMIN);
      const { departmentId } = await ensureE2eOptions(prisma);

      const res = await agent
        .patch(url(`/system-users/${ids[ADMIN]}`))
        .set('x-csrf-token', token)
        .send({ departmentId })
        .expect(200);

      expect((res.body as { department: { id: number } }).department.id).toBe(
        departmentId,
      );
    });

    it('E1 — that self-patch also covers the ordinary profile fields', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`/system-users/${ids[ADMIN]}`))
        .set('x-csrf-token', token)
        .send({ firstName: 'Self Rename' })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({ firstName: 'Self Rename' }),
        );
    });

    it('E2 — an ADMIN patching their OWN role or isActive is STILL 403, with the self reasons', async () => {
      const { agent, token } = await login(ADMIN);
      const self = url(`/system-users/${ids[ADMIN]}`);

      const active = await agent
        .patch(self)
        .set('x-csrf-token', token)
        .send({ isActive: false })
        .expect(403);
      expect((active.body as { message: string }).message).toBe(
        'You cannot change your own active status.',
      );

      // Step 5 fires before the ADMIN branch, so the reason is the SELF one — not
      // 'An ADMIN may only modify VIEWER users.' The frontend and this suite both assert it.
      const role = await agent
        .patch(self)
        .set('x-csrf-token', token)
        .send({ role: SystemRole.SUPER_ADMIN })
        .expect(403);
      expect((role.body as { message: string }).message).toBe(
        'You cannot change your own role.',
      );

      const row = await prisma.systemUser.findUnique({
        where: { id: ids[ADMIN] },
        select: { role: true, isActive: true },
      });
      expect(row).toEqual({ role: SystemRole.ADMIN, isActive: true });
    });

    it('E3 — the self-exception is id equality: an ADMIN patching ANOTHER ADMIN is still 403', async () => {
      const { agent, token } = await login(ADMIN);
      const { departmentId } = await ensureE2eOptions(prisma);

      const res = await agent
        .patch(url(`/system-users/${ids[ADMIN_2]}`))
        .set('x-csrf-token', token)
        .send({ departmentId })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        'An ADMIN may only modify VIEWER users.',
      );
    });

    it('AC-44 — an ADMIN sending any valid role value → 403, including a no-op role on a VIEWER target', async () => {
      const { agent, token } = await login(ADMIN);

      for (const role of Object.values(SystemRole)) {
        await agent
          .patch(url(`/system-users/${ids[VIEWER]}`))
          .set('x-csrf-token', token)
          .send({ role })
          .expect(403);
      }

      const row = await prisma.systemUser.findUnique({
        where: { id: ids[VIEWER] },
        select: { role: true },
      });
      expect(row?.role).toBe(SystemRole.VIEWER);
    });

    it('AC-62 — an ADMIN sending `{"role": null}` gets 400 at validation, not 403 at the policy', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .send({ role: null })
        .expect(400);
    });

    it('an ADMIN may patch a VIEWER target, including isActive', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`/system-users/${ids[VIEWER]}`))
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
        .send({ role: SystemRole.VIEWER })
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
      const { departmentId, personnelRoleId } = await ensureE2eOptions(prisma);
      await agent
        .patch(url(`/system-users/${ids[SUPER]}`))
        .set('x-csrf-token', token)
        .send({
          firstName: 'Ada',
          personnelRoleId,
          departmentId,
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
          .patch(url(`/system-users/${ids[VIEWER]}`))
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
        where: { id: ids[VIEWER] },
        select: { updatedAt: true },
      });

      await agent
        .patch(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .send({})
        .expect(400);

      const after = await prisma.systemUser.findUnique({
        where: { id: ids[VIEWER] },
        select: { updatedAt: true },
      });
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    });

    it('AC-62 — an explicit null clears the nullable columns; null on a NOT NULL column is 400', async () => {
      const { agent, token } = await login(SUPER);
      const target = url(`/system-users/${ids[VIEWER]}`);

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
        .patch(url(`/system-users/${ids[VIEWER]}`))
        .send({ firstName: 'X' })
        .expect(403);
    });

    it('AC-53 — PATCH on a soft-deleted id → 404', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .expect(204);
      await agent
        .patch(url(`/system-users/${ids[VIEWER]}`))
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
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .expect(204);
      expect(res.text).toBe('');
      expect(res.body).toEqual({});

      // Soft delete: `SELECT count(*)` is unchanged — the row is still physically present.
      await expect(physicalRows()).resolves.toBe(countBefore);
      const row = await prisma.systemUser.findUnique({
        where: { id: ids[VIEWER] },
        select: { deletedAt: true },
      });
      expect(row?.deletedAt).not.toBeNull();
    });

    it('AC-53 — a second DELETE, and a DELETE of an id that never existed, are byte-identical 404s', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .expect(204);

      const second = await agent
        .delete(url(`/system-users/${ids[VIEWER]}`))
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
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .expect(204);

      const res = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({
          email: VIEWER,
          firstName: 'Impostor',
          lastName: 'User',
          ...(await ensureE2eOptions(prisma)),
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
        where: { id: ids[VIEWER] },
      });

      await agent
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .expect(204);
      const res = await agent
        .post(url(`/system-users/${ids[VIEWER]}/restore`))
        .set('x-csrf-token', token)
        .expect(200);

      expect(res.body).toMatchObject({
        id: ids[VIEWER],
        email: VIEWER,
        role: SystemRole.VIEWER,
      });
      expect(JSON.stringify(res.body)).not.toContain('deletedAt');

      const after = await prisma.systemUser.findUnique({
        where: { id: ids[VIEWER] },
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
      expect(list.data.map((u) => u.email)).toContain(VIEWER);
    });

    it('AC-55 — a user suspended before deletion comes back suspended (the flags are orthogonal)', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .send({ isActive: false })
        .expect(200);
      await agent
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', token)
        .expect(204);

      const res = await agent
        .post(url(`/system-users/${ids[VIEWER]}/restore`))
        .set('x-csrf-token', token)
        .expect(200);
      expect(res.body).toMatchObject({ isActive: false });
    });

    it('AC-56 — restore on a live row → 409; on an unknown id → 404; as an ADMIN → 403', async () => {
      const sa = await login(SUPER);
      const live = await sa.agent
        .post(url(`/system-users/${ids[VIEWER]}/restore`))
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
        .post(url(`/system-users/${ids[VIEWER]}/restore`))
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
      const victim = await login(VIEWER);
      await victim.agent.get(url('/auth/system/me')).expect(200);

      const sa = await login(SUPER);
      await sa.agent
        .delete(url(`/system-users/${ids[VIEWER]}`))
        .set('x-csrf-token', sa.token)
        .expect(204);

      await victim.agent.get(url('/auth/system/me')).expect(401);
    });

    it('AC-27 — a user deactivated mid-session is rejected on their next request, not at expiry', async () => {
      const victim = await login(VIEWER);
      const sa = await login(SUPER);
      await sa.agent
        .patch(url(`/system-users/${ids[VIEWER]}`))
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
        .send({ role: SystemRole.VIEWER })
        .expect(200);

      /*
       * "Loses /system-users" is now about the WRITES: since 19 ส.ค. 2569 a VIEWER may read the
       * directory, so the demotion is felt on the routes the role actually gated. `status=deleted`
       * is the read that still tells them apart, and it is checked here for the same reason — it
       * is judged inside the service, not by `RolesGuard`.
       */
      await victim.agent
        .patch(url(`/system-users/${ids[ADMIN]}`))
        .set('x-csrf-token', victim.token)
        .send({ firstName: 'Nope' })
        .expect(403);
      await victim.agent.get(url('/system-users?status=deleted')).expect(403);

      // …and the reads they are now entitled to keep working, on the SAME cookie.
      await victim.agent.get(url('/system-users')).expect(200);
      await victim.agent.get(url('/auth/system/me')).expect(200);
    });
  });
});
