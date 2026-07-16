import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
    // mustChangePassword: false — these fixtures are already-onboarded users. The model default
    // is TRUE (deny by default), so omitting it would gate every fixture into a 403.
    const base = {
      passwordHash,
      mustChangePassword: false,
      ...(await ensureE2eOptions(prisma)),
    };
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

  // ───────── AC-X3 — the boundary under the new SystemUser -> PersonnelRole FK ─────────
  //
  // The FK makes the confusion NEWLY CONSTRUCTIBLE: `role` (RBAC) and `personnelRole` (job title)
  // are now adjacent fields on one model, so `if (user.personnelRole.name === 'ADMIN')` is typeable.
  // This is the load-bearing guard for D-2 — it must fail the build the day someone writes that.

  it('AC-X3 — a STAFF user ASSIGNED a PersonnelRole named "ADMIN" still has ZERO privilege', async () => {
    const roleName = `${OPT_PREFIX}ADMIN`;
    const deptName = `${OPT_PREFIX}SUPER_ADMIN`;

    // A PersonnelRole named after the highest RBAC role, and a Department named after it too.
    const personnelRole = await prisma.personnelRole.create({
      data: { name: roleName },
      select: { id: true },
    });
    const department = await prisma.department.create({
      data: { name: deptName },
      select: { id: true },
    });

    // A STAFF user wearing both inert labels.
    const email = `${SU_PREFIX}impostor@easybook.local`;
    const impostor = await prisma.systemUser.create({
      data: {
        email,
        passwordHash: await new PasswordService().hash(PASSWORD),
        firstName: 'E2E',
        lastName: 'Impostor',
        role: SystemRole.STAFF, // the ONLY thing that grants privilege
        departmentId: department.id,
        personnelRoleId: personnelRole.id,
      },
      select: { id: true },
    });

    const other = await prisma.systemUser.findFirstOrThrow({
      where: { email: STAFF },
      select: { id: true },
    });

    const { agent, token } = await login(email);

    // The job title changed NOTHING: STAFF is denied the whole admin surface.
    await agent.get(url('/system-users')).expect(403);
    await agent
      .patch(url(`/system-users/${other.id}`))
      .set('x-csrf-token', token)
      .send({ firstName: 'Escalated' })
      .expect(403);
    await agent.get(url('/personnel-roles')).expect(403);
    await agent.get(url('/departments')).expect(403);

    // THE load-bearing assertion: the two coexist and DISAGREE in one body, and RBAC wins.
    const me = await agent.get(url('/auth/system/me')).expect(200);
    const body = me.body as {
      id: string;
      role: SystemRole;
      personnelRole: { name: string };
      department: { name: string };
    };
    expect(body.id).toBe(impostor.id);
    expect(body.role).toBe('STAFF');
    expect(body.personnelRole.name).toBe(roleName);
    expect(body.department.name).toBe(deptName);
    // Same body, two "ADMIN"s, zero privilege.
    expect(body.role).not.toBe(body.personnelRole.name);
  });

  /**
   * AC-X3's "no shared code path" obligation, as a static guard.
   *
   * NOTE — the design (§8.2) phrases this as "nothing under `src/options/` imports `SystemRole`".
   * Taken literally that is FALSE today and was false before this feature: both option controllers
   * import `SystemRole` for `@Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)`, which is how the
   * admin CRUD surface is RBAC-guarded — necessary, correct, and the opposite of a leak. Asserting
   * the literal sentence would force deleting real authorization.
   *
   * So this tests the INTENT: option DATA (`.name`) must never be fed into an authorization
   * expression. That is the actual privilege-escalation shape D-2 warns about.
   */
  const srcFiles = (): string[] => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(d, entry.name)) : [join(d, entry.name)],
      );
    return walk(join(__dirname, '..', 'src')).filter((f) => f.endsWith('.ts'));
  };

  it('AC-X3 — no code anywhere compares a PersonnelRole/Department name against anything', () => {
    // `if (user.personnelRole.name === 'ADMIN')` — the exact bug the FK makes typeable.
    const forbidden =
      /\b(personnelRole|department)\s*(\?\.)?\.\s*name\s*(===|==|!==|!=)/;
    const offenders = srcFiles().filter((f) =>
      forbidden.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('AC-X3 — src/options/ touches SystemRole ONLY inside @Roles() guards, never option logic', () => {
    const offenders: string[] = [];
    const optionsDir = join(__dirname, '..', 'src', 'options');
    for (const file of srcFiles().filter((f) => f.startsWith(optionsDir))) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('SystemRole')) continue;
        const ok =
          line.includes('@Roles(') || // the RBAC guard — legitimate
          line.trimStart().startsWith('import') || // its import
          line.trimStart().startsWith('*') || // a doc comment
          line.trimStart().startsWith('//');
        if (!ok) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
