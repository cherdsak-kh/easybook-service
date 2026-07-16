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

const SU_PREFIX = 'e2e-optsu-';
const OPT_PREFIX = 'e2e-opt-';
const PASSWORD = 'e2e-correct-horse-battery';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const STAFF = `${SU_PREFIX}staff@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface OptionBody {
  id: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// Runs the same CRUD contract against each option resource.
const RESOURCES = ['departments', 'personnel-roles'] as const;

describe('Registration options admin CRUD (e2e)', () => {
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

  const purgeOptions = async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE "name" LIKE '${OPT_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM personnel_roles WHERE "name" LIKE '${OPT_PREFIX}%'`,
    );
  };

  const seed = async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeOptions();
    const passwordHash = await new PasswordService().hash(PASSWORD);
    const base = { passwordHash, position: 'Director', department: 'IT' };
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [STAFF, SystemRole.STAFF],
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
    await purgeOptions();
    await clearThrottleCounters(redis);
    await app.close();
  });

  describe.each(RESOURCES)('/%s', (resource) => {
    const base = `/${resource}`;
    const name = (suffix: string) => `${OPT_PREFIX}${resource}-${suffix}`;

    it('SC-B3/B4 — no session is 401 on every method', async () => {
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

    it('SC-B3/B4 — STAFF is 403 on read and write (SUPER_ADMIN/ADMIN only)', async () => {
      const { agent, token } = await login(STAFF);
      await agent.get(url(base)).expect(403);
      await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('staff') })
        .expect(403);
    });

    it('SC-B3/B4 — ADMIN can create, list (name ASC), rename, and soft-delete', async () => {
      const { agent, token } = await login(ADMIN);

      const created = await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('bbb') })
        .expect(201);
      const id = (created.body as OptionBody).id;
      expect((created.body as OptionBody).name).toBe(name('bbb'));
      // deletedAt is never exposed.
      expect(JSON.stringify(created.body)).not.toContain('deletedAt');

      await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: name('aaa') })
        .expect(201);

      const list = await agent.get(url(base)).expect(200);
      const names = (list.body as OptionBody[])
        .map((o) => o.name)
        .filter((n) => n.startsWith(OPT_PREFIX));
      // name ASC: aaa before bbb.
      expect(names.indexOf(name('aaa'))).toBeLessThan(
        names.indexOf(name('bbb')),
      );

      // Rename.
      const renamed = await agent
        .patch(url(`${base}/${id}`))
        .set('x-csrf-token', token)
        .send({ name: name('renamed') })
        .expect(200);
      expect((renamed.body as OptionBody).name).toBe(name('renamed'));

      // Soft-delete (204, empty body) then it disappears from the list.
      await agent
        .delete(url(`${base}/${id}`))
        .set('x-csrf-token', token)
        .expect(204);
      const afterDelete = await agent.get(url(base)).expect(200);
      expect((afterDelete.body as OptionBody[]).some((o) => o.id === id)).toBe(
        false,
      );

      // Still a real row (soft delete): a second DELETE is a 404, byte-identical to unknown.
      await agent
        .delete(url(`${base}/${id}`))
        .set('x-csrf-token', token)
        .expect(404);
    });

    it('SC-B7 — a duplicate ACTIVE name is 409; re-creating a soft-deleted name is 201 (partial unique)', async () => {
      const { agent, token } = await login(SUPER);
      const n = name('reuse');

      const first = await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: n })
        .expect(201);
      const firstId = (first.body as OptionBody).id;

      // Duplicate active name → 409.
      await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: n })
        .expect(409);

      // Soft-delete, then the same name may be created again (a NEW row).
      await agent
        .delete(url(`${base}/${firstId}`))
        .set('x-csrf-token', token)
        .expect(204);
      const recreated = await agent
        .post(url(base))
        .set('x-csrf-token', token)
        .send({ name: n })
        .expect(201);
      expect((recreated.body as OptionBody).id).not.toBe(firstId);
    });

    it('SC-4 — a mutation without x-csrf-token is 403', async () => {
      const { agent } = await login(ADMIN);
      await agent
        .post(url(base))
        .send({ name: name('nocsrf') })
        .expect(403);
    });

    it('404s a PATCH/DELETE on an unknown (but numeric) id', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`${base}/2147483000`))
        .set('x-csrf-token', token)
        .send({ name: name('x') })
        .expect(404);
      await agent
        .delete(url(`${base}/2147483000`))
        .set('x-csrf-token', token)
        .expect(404);
    });

    it('400s a PATCH/DELETE on a non-numeric id (ParseIntPipe)', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(url(`${base}/never-existed`))
        .set('x-csrf-token', token)
        .send({ name: name('x') })
        .expect(400);
      await agent
        .delete(url(`${base}/never-existed`))
        .set('x-csrf-token', token)
        .expect(400);
    });
  });

  // ─────────────────── PersonnelRole ≠ SystemRole cross-check (SC-B4) ───────────────────

  it('SC-B4 — a PersonnelRole named "ADMIN" is a plain option and grants NO back-office privilege', async () => {
    const { agent, token } = await login(ADMIN);

    // Creating a PersonnelRole literally named after a SystemRole is allowed and inert.
    const created = await agent
      .post(url('/personnel-roles'))
      .set('x-csrf-token', token)
      .send({ name: `${OPT_PREFIX}ADMIN` })
      .expect(201);
    expect((created.body as OptionBody).name).toBe(`${OPT_PREFIX}ADMIN`);

    // It lands in personnel_roles, NOT in the SystemUser/role space — the STAFF whose role would
    // "match" still cannot touch the options surface (RBAC is unaffected by option data).
    const roleRow = await prisma.personnelRole.findFirst({
      where: { name: `${OPT_PREFIX}ADMIN` },
      select: { id: true },
    });
    expect(roleRow).not.toBeNull();
    const staffSession = await login(STAFF);
    await staffSession.agent.get(url('/personnel-roles')).expect(403);

    // The same name may exist independently as a Department — separate tables, no collision.
    await agent
      .post(url('/departments'))
      .set('x-csrf-token', token)
      .send({ name: `${OPT_PREFIX}ADMIN` })
      .expect(201);
  });
});
