import { BadGatewayException, Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INVALID_CURRENT_PASSWORD,
  MUST_CHANGE_PASSWORD,
  PASSWORD_UNCHANGED,
} from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2StorageService } from '../src/storage/r2-storage.service';
import {
  AVATAR_TOO_LARGE,
  AVATAR_TYPE_UNSUPPORTED,
} from '../src/storage/storage.errors';
import { CANNOT_RESET_OWN_PASSWORD } from '../src/system-users/system-users.policy';
import {
  clearThrottleCounters,
  createE2eApp,
  prismaOf,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(180_000);

const PREFIX = 'e2e-staff-';
const OPT_PREFIX = 'e2e-staffopt-';
const PASSWORD = 'e2e-correct-horse-battery';

const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const STAFF = `${PREFIX}staff@easybook.local`;
const GATED = `${PREFIX}gated@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;
const R2_BASE = 'https://pub-e2e-fake.r2.dev';

interface Session {
  agent: request.Agent;
  token: string;
}
interface UserBody {
  id: string;
  role: SystemRole;
  mustChangePassword: boolean;
  temporaryPassword?: string;
  profilePictureUrl: string | null;
  firstName: string;
  lastName: string;
  phoneNumber: string | null;
  department: { id: number; name: string };
  personnelRole: { id: number; name: string };
}

/** A byte-accurate PNG header + filler. */
const pngBytes = (size = 64): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, size - 8)),
  ]);

describe('Staff Management (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  const ids: Record<string, string> = {};
  let departmentId = 0;
  let personnelRoleId = 0;

  // The R2 seam, faked. The e2e suite must NEVER hit real object storage.
  const putAvatar = jest.fn();
  const deleteObject = jest.fn();
  const storageFake = {
    isConfigured: () => true,
    publicBaseUrl: () => R2_BASE,
    buildAvatarKey: (userId: string, type: string) =>
      `avatars/${userId}/${'a'.repeat(32)}.${type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp'}`,
    publicUrlFor: (key: string) => `${R2_BASE}/${key}`,
    putAvatar,
    deleteObject,
  };

  const server = () => app.getHttpServer();

  const login = async (
    email: string,
    password: string = PASSWORD,
  ): Promise<Session> => {
    const agent = request.agent(server());
    const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    await agent
      .post(url('/auth/system/login'))
      .set('x-csrf-token', token)
      .send({ email, password })
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
    await purgeE2eUsers(prisma, PREFIX);
    await purgeOptions();

    const department = await prisma.department.create({
      data: { name: `${OPT_PREFIX}dept` },
      select: { id: true },
    });
    const personnelRole = await prisma.personnelRole.create({
      data: { name: `${OPT_PREFIX}role` },
      select: { id: true },
    });
    departmentId = department.id;
    personnelRoleId = personnelRole.id;

    const passwordHash = await new PasswordService().hash(PASSWORD);
    const base = { passwordHash, departmentId, personnelRoleId };

    for (const [email, role, mustChangePassword] of [
      [SUPER, SystemRole.SUPER_ADMIN, false],
      [ADMIN, SystemRole.ADMIN, false],
      [STAFF, SystemRole.STAFF, false],
      [GATED, SystemRole.STAFF, true], // holds an outstanding temp password
    ] as Array<[string, SystemRole, boolean]>) {
      const created = await prisma.systemUser.create({
        data: {
          email,
          firstName: 'E2E',
          lastName: role,
          role,
          mustChangePassword,
          ...base,
        },
        select: { id: true },
      });
      ids[email] = created.id;
    }
  };

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(R2StorageService).useValue(storageFake),
    );
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
  }, 90_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    putAvatar.mockResolvedValue(undefined);
    deleteObject.mockResolvedValue(true);
    await clearThrottleCounters(redis);
    await seed();
  });

  afterAll(async () => {
    await purgeE2eUsers(prisma, PREFIX);
    await purgeOptions();
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ═══════════════ AC-B8/B9 — the forced-reset gate: THE lockout matrix ═══════════════
  //
  // Getting this allowlist wrong is either a permanent lockout (the reset door closed) or a hole
  // (everything open). It is the single highest-severity behaviour in this feature.

  describe('the forced-reset gate — exempt-allowlist lockout matrix', () => {
    it('EXEMPT — GET /auth/system/csrf is reachable while gated (every mutation needs the token)', async () => {
      const agent = request.agent(server());
      await agent.get(url('/auth/system/csrf')).expect(200); // unguarded entirely
    });

    it('EXEMPT — login with the temp password works, and GET /auth/system/me returns 200 + the flag', async () => {
      const { agent } = await login(GATED);
      const me = await agent.get(url('/auth/system/me')).expect(200);
      expect((me.body as UserBody).mustChangePassword).toBe(true);
      // The SPA routes off THIS body — blocking it would leave it unable to learn why it is 403'd.
    });

    it('EXEMPT — POST /auth/system/logout is reachable while gated (a user may always leave)', async () => {
      const { agent, token } = await login(GATED);
      await agent
        .post(url('/auth/system/logout'))
        .set('x-csrf-token', token)
        .expect(200);
    });

    it('EXEMPT — POST /auth/system/password is reachable while gated (THE door out)', async () => {
      const { agent, token } = await login(GATED);
      await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({
          currentPassword: PASSWORD,
          newPassword: 'a-brand-new-password',
        })
        .expect(200);
    });

    it('EXEMPT — GET /health stays reachable (liveness must never depend on a user)', async () => {
      const { agent } = await login(GATED);
      await agent.get(url('/health')).expect(200);
    });

    it.each([
      ['GET', '/system-users'],
      ['GET', '/system-users/me-placeholder'],
      ['GET', '/departments'],
      ['GET', '/personnel-roles'],
    ])('GATED — %s %s answers 403 MUST_CHANGE_PASSWORD', async (_m, path) => {
      const { agent } = await login(GATED);
      const res = await agent.get(url(path)).expect(403);
      expect((res.body as { message: string }).message).toBe(
        MUST_CHANGE_PASSWORD,
      );
    });

    it('GATED — PATCH /auth/system/me answers 403 (editing your name is not a way out)', async () => {
      const { agent, token } = await login(GATED);
      const res = await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({ firstName: 'Nope' })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        MUST_CHANGE_PASSWORD,
      );
    });

    it('GATED — POST /auth/system/me/avatar answers 403 (it sits beside three exempt routes)', async () => {
      const { agent, token } = await login(GATED);
      const res = await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', pngBytes(), 'a.png')
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        MUST_CHANGE_PASSWORD,
      );
      expect(putAvatar).not.toHaveBeenCalled();
    });

    it('GATED — the write routes on /system-users answer 403, not 400/404', async () => {
      const { agent, token } = await login(GATED);
      const target = ids[STAFF];
      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({})
        .expect(403);
      await agent
        .patch(url(`/system-users/${target}`))
        .set('x-csrf-token', token)
        .send({ firstName: 'X' })
        .expect(403);
      await agent
        .delete(url(`/system-users/${target}`))
        .set('x-csrf-token', token)
        .expect(403);
      await agent
        .post(url(`/system-users/${target}/restore`))
        .set('x-csrf-token', token)
        .expect(403);
      await agent
        .post(url(`/system-users/${target}/reset-password`))
        .set('x-csrf-token', token)
        .expect(403);
    });

    it('AC-B9 — after changing the password, the VERY NEXT request to a gated route succeeds on the SAME cookie, with no re-login', async () => {
      const { agent, token } = await login(GATED);

      // Gated first.
      await agent.get(url('/system-users')).expect(403);

      await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({
          currentPassword: PASSWORD,
          newPassword: 'a-brand-new-password',
        })
        .expect(200);

      // Same agent, same cookie, no re-login: SessionGuard's per-request DB re-read is what makes
      // this work — and is why no session-revocation machinery exists.
      // STAFF is 403 on /system-users by ROLE, so assert on a route STAFF may reach.
      const me = await agent.get(url('/auth/system/me')).expect(200);
      expect((me.body as UserBody).mustChangePassword).toBe(false);

      const patched = await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({ firstName: 'Freed' })
        .expect(200);
      expect((patched.body as UserBody).firstName).toBe('Freed');
    });

    it('an UNGATED user is unaffected everywhere', async () => {
      const { agent } = await login(SUPER);
      await agent.get(url('/system-users')).expect(200);
      const me = await agent.get(url('/auth/system/me')).expect(200);
      expect((me.body as UserBody).mustChangePassword).toBe(false);
    });

    it('ORDERING — a SUSPENDED user who is also gated gets 401 at login, never the reset screen', async () => {
      await prisma.systemUser.update({
        where: { id: ids[GATED] },
        data: { isActive: false },
      });
      const agent = request.agent(server());
      const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
      await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .send({ email: GATED, password: PASSWORD })
        .expect(401); // the lifecycle flags win, and they fire first
    });
  });

  // ═══════════════ AC-B7 — temp password: issued once, hash-only at rest ═══════════════

  describe('temporary passwords', () => {
    const newUser = () => ({
      email: `${PREFIX}created@easybook.local`,
      firstName: 'Created',
      lastName: 'User',
      departmentId,
      personnelRoleId,
    });

    it('POST /system-users returns temporaryPassword once, sets the flag, and the temp password LOGS IN', async () => {
      const { agent, token } = await login(SUPER);

      const created = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send(newUser())
        .expect(201);

      const body = created.body as UserBody;
      expect(body.temporaryPassword).toEqual(expect.any(String));
      expect(body.temporaryPassword).toHaveLength(16);
      expect(body.mustChangePassword).toBe(true);

      // It genuinely works as a credential...
      const fresh = await login(newUser().email, body.temporaryPassword);
      const me = await fresh.agent.get(url('/auth/system/me')).expect(200);
      expect((me.body as UserBody).mustChangePassword).toBe(true);

      // ...and is NEVER retrievable again: a subsequent read has no such field.
      const read = await agent.get(url(`/system-users/${body.id}`)).expect(200);
      expect(read.body).not.toHaveProperty('temporaryPassword');
    });

    it('AC-B7 — the plaintext is stored ONLY as an argon2id digest, never in any column', async () => {
      const { agent, token } = await login(SUPER);
      const created = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send(newUser())
        .expect(201);
      const { id, temporaryPassword } = created.body as UserBody;

      const row = await prisma.systemUser.findUniqueOrThrow({ where: { id } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toContain(temporaryPassword);
      // No column anywhere holds the plaintext.
      expect(JSON.stringify(row)).not.toContain(temporaryPassword);
    });

    it('AC-B7 — the temp password is never logged', async () => {
      const { agent, token } = await login(SUPER);
      const written: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          jest
            .spyOn(Logger.prototype, level)
            .mockImplementation((...args: unknown[]) => {
              written.push(args.map((a) => String(a)).join(' '));
            }),
      );

      try {
        const created = await agent
          .post(url('/system-users'))
          .set('x-csrf-token', token)
          .send(newUser())
          .expect(201);
        const { temporaryPassword } = created.body as UserBody;

        expect(written.length).toBeGreaterThan(0); // the create IS logged (id= only)
        for (const line of written) {
          expect(line).not.toContain(temporaryPassword);
        }
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it('AC-B7 — `password` in the create body is a 400: it would be a second credential path', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({ ...newUser(), password: 'i-choose-my-own-password' })
        .expect(400);
    });

    it('POST :id/reset-password issues a NEW temp password, gates the target, and kills the old password', async () => {
      const { agent, token } = await login(SUPER);

      const res = await agent
        .post(url(`/system-users/${ids[STAFF]}/reset-password`))
        .set('x-csrf-token', token)
        .expect(200); // 200, NOT 201 — it creates nothing

      const { temporaryPassword, mustChangePassword } = res.body as UserBody;
      expect(temporaryPassword).toHaveLength(16);
      expect(mustChangePassword).toBe(true);

      // The old password no longer works; the new one does.
      const stale = request.agent(server());
      const csrf = await stale.get(url('/auth/system/csrf')).expect(200);
      await stale
        .post(url('/auth/system/login'))
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .send({ email: STAFF, password: PASSWORD })
        .expect(401);

      await clearThrottleCounters(redis);
      await login(STAFF, temporaryPassword);
    });

    it('reset-password: 403 for a non-SUPER_ADMIN, 403 on self, 404 on a soft-deleted id', async () => {
      const adminSession = await login(ADMIN);
      await adminSession.agent
        .post(url(`/system-users/${ids[STAFF]}/reset-password`))
        .set('x-csrf-token', adminSession.token)
        .expect(403);

      const { agent, token } = await login(SUPER);
      const self = await agent
        .post(url(`/system-users/${ids[SUPER]}/reset-password`))
        .set('x-csrf-token', token)
        .expect(403);
      expect((self.body as { message: string }).message).toBe(
        CANNOT_RESET_OWN_PASSWORD,
      );

      await prisma.systemUser.update({
        where: { id: ids[STAFF] },
        data: { deletedAt: new Date() },
      });
      await agent
        .post(url(`/system-users/${ids[STAFF]}/reset-password`))
        .set('x-csrf-token', token)
        .expect(404);
    });

    it('reset-password: a SUSPENDED target is valid (200) — the flags are orthogonal', async () => {
      await prisma.systemUser.update({
        where: { id: ids[STAFF] },
        data: { isActive: false },
      });
      const { agent, token } = await login(SUPER);
      await agent
        .post(url(`/system-users/${ids[STAFF]}/reset-password`))
        .set('x-csrf-token', token)
        .expect(200);
    });

    it('reset-password requires the CSRF header', async () => {
      const { agent } = await login(SUPER);
      await agent
        .post(url(`/system-users/${ids[STAFF]}/reset-password`))
        .expect(403);
    });
  });

  // ═══════════════ §5.3 — change password ═══════════════

  describe('POST /auth/system/password', () => {
    it('a WRONG currentPassword is 400, NOT 401 — a 401 would log the user out for a typo', async () => {
      const { agent, token } = await login(STAFF);

      const res = await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({
          currentPassword: 'wrong-password',
          newPassword: 'a-fine-new-password',
        })
        .expect(400);

      expect(res.status).not.toBe(401); // the regression this test exists for
      expect((res.body as { message: string }).message).toBe(
        INVALID_CURRENT_PASSWORD,
      );

      // The session SURVIVES the failed attempt.
      await agent.get(url('/auth/system/me')).expect(200);
    });

    it('rejects a new password that is < 12 chars, or identical to the current one', async () => {
      const { agent, token } = await login(STAFF);

      await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({ currentPassword: PASSWORD, newPassword: 'short' })
        .expect(400);

      const same = await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({ currentPassword: PASSWORD, newPassword: PASSWORD })
        .expect(400);
      expect((same.body as { message: string }).message).toBe(
        PASSWORD_UNCHANGED,
      );
    });

    it('rejects an extra key and a missing currentPassword', async () => {
      const { agent, token } = await login(STAFF);
      await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({
          currentPassword: PASSWORD,
          newPassword: 'a-fine-new-password',
          confirmPassword: 'a-fine-new-password',
        })
        .expect(400);
      await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({ newPassword: 'a-fine-new-password' })
        .expect(400);
    });

    it('on success the old password fails login, the new one works, and the flag clears', async () => {
      const { agent, token } = await login(GATED);
      await agent
        .post(url('/auth/system/password'))
        .set('x-csrf-token', token)
        .send({
          currentPassword: PASSWORD,
          newPassword: 'my-chosen-password-1',
        })
        .expect(200);

      await clearThrottleCounters(redis);
      const stale = request.agent(server());
      const csrf = await stale.get(url('/auth/system/csrf')).expect(200);
      await stale
        .post(url('/auth/system/login'))
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .send({ email: GATED, password: PASSWORD })
        .expect(401);

      await clearThrottleCounters(redis);
      const fresh = await login(GATED, 'my-chosen-password-1');
      const me = await fresh.agent.get(url('/auth/system/me')).expect(200);
      expect((me.body as UserBody).mustChangePassword).toBe(false);
    });

    it('requires the CSRF header', async () => {
      const { agent } = await login(STAFF);
      await agent
        .post(url('/auth/system/password'))
        .send({ currentPassword: PASSWORD, newPassword: 'a-fine-new-password' })
        .expect(403);
    });
  });

  // ═══════════════ AC-B3/B4 — the option FKs, read/write asymmetry ═══════════════

  describe('option references', () => {
    it('create/update accept ids and the response embeds {id,name} for both', async () => {
      const { agent, token } = await login(SUPER);

      const created = await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({
          email: `${PREFIX}opt@easybook.local`,
          firstName: 'Opt',
          lastName: 'User',
          departmentId,
          personnelRoleId,
        })
        .expect(201);

      const body = created.body as UserBody;
      expect(body.department).toEqual({
        id: departmentId,
        name: `${OPT_PREFIX}dept`,
      });
      expect(body.personnelRole).toEqual({
        id: personnelRoleId,
        name: `${OPT_PREFIX}role`,
      });
    });

    it.each([
      ['departmentId', 999_999_99],
      ['personnelRoleId', 999_999_99],
    ])('AC-B3 — an UNKNOWN %s is a 400', async (field, value) => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ [field]: value })
        .expect(400);
    });

    it('AC-B3 — assigning a SOFT-DELETED option is a 400 (the FK alone would accept it)', async () => {
      const dead = await prisma.department.create({
        data: { name: `${OPT_PREFIX}dead`, deletedAt: new Date() },
        select: { id: true },
      });
      const { agent, token } = await login(SUPER);

      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ departmentId: dead.id })
        .expect(400);
    });

    it('AC-B4 — an EXISTING assignment still resolves after its option is soft-deleted', async () => {
      const { agent } = await login(SUPER);

      // Soft-delete the option the fixture users are assigned to.
      await prisma.department.update({
        where: { id: departmentId },
        data: { deletedAt: new Date() },
      });

      // Read still resolves the name — the nested select carries NO deletedAt filter.
      const read = await agent
        .get(url(`/system-users/${ids[STAFF]}`))
        .expect(200);
      expect((read.body as UserBody).department).toEqual({
        id: departmentId,
        name: `${OPT_PREFIX}dept`,
      });

      // ...and the list does too, rather than 500ing on a null relation.
      const list = await agent.get(url('/system-users')).expect(200);
      const row = (list.body as { data: UserBody[] }).data.find(
        (u) => u.id === ids[STAFF],
      );
      expect(row?.department.name).toBe(`${OPT_PREFIX}dept`);
    });

    it('AC-B3 — a rejected write leaves the existing assignment untouched', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ departmentId: 999_999_99 })
        .expect(400);

      const row = await prisma.systemUser.findUniqueOrThrow({
        where: { id: ids[STAFF] },
        select: { departmentId: true },
      });
      expect(row.departmentId).toBe(departmentId);
    });

    it('rejects a string id — no implicit conversion means "3" is not 3', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(url(`/system-users/${ids[STAFF]}`))
        .set('x-csrf-token', token)
        .send({ departmentId: String(departmentId) })
        .expect(400);
    });
  });

  // ═══════════════ AC-B11 — self-profile ═══════════════

  describe('PATCH /auth/system/me', () => {
    it('updates the four allowed fields', async () => {
      const { agent, token } = await login(STAFF);

      const res = await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({
          firstName: 'Ada',
          lastName: 'Lovelace',
          phoneNumber: '02-123-4567',
          profilePictureUrl: 'https://cdn.example.com/a.jpg',
        })
        .expect(200);

      const body = res.body as UserBody;
      expect(body.firstName).toBe('Ada');
      expect(body.lastName).toBe('Lovelace');
      expect(body.phoneNumber).toBe('02-123-4567');
      expect(body.profilePictureUrl).toBe('https://cdn.example.com/a.jpg');
    });

    it.each([
      ['role', SystemRole.SUPER_ADMIN],
      ['isActive', false],
      ['departmentId', 1],
      ['personnelRoleId', 1],
      ['email', 'new@easybook.local'],
      ['password', 'a-long-enough-password'],
      ['lineUserId', 'clx0000000000000000000000'],
      ['mustChangePassword', false],
      ['deletedAt', null],
      ['id', 'other-id'],
    ])(
      'AC-B11 — `%s` is absent from the DTO, so forbidNonWhitelisted 400s it',
      async (key, value) => {
        const { agent, token } = await login(STAFF);
        await agent
          .patch(url('/auth/system/me'))
          .set('x-csrf-token', token)
          .send({ [key]: value })
          .expect(400);
      },
    );

    it('AC-B11 — a STAFF cannot escalate: role stays STAFF and the row is untouched', async () => {
      const { agent, token } = await login(STAFF);
      await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({ firstName: 'Ada', role: SystemRole.SUPER_ADMIN })
        .expect(400);

      const row = await prisma.systemUser.findUniqueOrThrow({
        where: { id: ids[STAFF] },
        select: { role: true, firstName: true },
      });
      expect(row.role).toBe(SystemRole.STAFF);
      expect(row.firstName).toBe('E2E'); // the whole body was rejected, not partially applied
    });

    it('an empty body is a 400; `{"firstName": null}` is a 400, not a 500', async () => {
      const { agent, token } = await login(STAFF);
      await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({})
        .expect(400);
      await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({ firstName: null })
        .expect(400);
    });

    it('`{"phoneNumber": null}` clears the value (200)', async () => {
      await prisma.systemUser.update({
        where: { id: ids[STAFF] },
        data: { phoneNumber: '02-000-0000' },
      });
      const { agent, token } = await login(STAFF);

      const res = await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({ phoneNumber: null })
        .expect(200);
      expect((res.body as UserBody).phoneNumber).toBeNull();
    });

    it('rejects a non-https profilePictureUrl', async () => {
      const { agent, token } = await login(STAFF);
      await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({ profilePictureUrl: 'http://cdn.example.com/a.jpg' })
        .expect(400);
      await agent
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', token)
        .send({ profilePictureUrl: 'javascript:alert(1)' })
        .expect(400);
    });

    it('requires the CSRF header, and a session', async () => {
      const { agent } = await login(STAFF);
      await agent
        .patch(url('/auth/system/me'))
        .send({ firstName: 'X' })
        .expect(403);

      const anon = request.agent(server());
      const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
      await anon
        .patch(url('/auth/system/me'))
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .send({ firstName: 'X' })
        .expect(401);
    });
  });

  // ═══════════════ AC-B13 — avatar upload ═══════════════

  describe('POST /auth/system/me/avatar', () => {
    it('accepts a valid PNG, stores it under an unguessable key, and returns the new URL', async () => {
      const { agent, token } = await login(STAFF);

      const res = await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', pngBytes(), 'me.png')
        .expect(200);

      const body = res.body as UserBody;
      expect(body.profilePictureUrl).toMatch(
        new RegExp(`^${R2_BASE}/avatars/${ids[STAFF]}/[0-9a-f]{32}\\.png$`),
      );
      expect(putAvatar).toHaveBeenCalledTimes(1);
      expect(putAvatar).toHaveBeenCalledWith(
        expect.stringMatching(/^avatars\//),
        expect.any(Buffer),
        'image/png',
      );

      // Persisted, and https (AC-B15).
      const row = await prisma.systemUser.findUniqueOrThrow({
        where: { id: ids[STAFF] },
        select: { profilePictureUrl: true },
      });
      expect(row.profilePictureUrl).toBe(body.profilePictureUrl);
      expect(row.profilePictureUrl?.startsWith('https://')).toBe(true);
    });

    it('AC-B13 — an EXE renamed .png with Content-Type image/png is a 400 (magic-byte control)', async () => {
      const { agent, token } = await login(STAFF);
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(128, 0x90)]);

      const res = await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', exe, { filename: 'me.png', contentType: 'image/png' })
        .expect(400);

      expect((res.body as { message: string }).message).toBe(
        AVATAR_TYPE_UNSUPPORTED,
      );
      expect(putAvatar).not.toHaveBeenCalled();
    });

    it('AC-B13 — 2 MiB + 1 byte is a 400, NOT a 413 (the MulterError mapping)', async () => {
      const { agent, token } = await login(STAFF);
      const tooBig = pngBytes(2 * 1024 * 1024 + 1);

      const res = await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', tooBig, {
          filename: 'big.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400); // 413 here is an AC-B13 FAIL
      expect((res.body as { message: string }).message).toBe(AVATAR_TOO_LARGE);
      expect(putAvatar).not.toHaveBeenCalled();
    });

    it('accepts a file exactly AT the 2 MiB limit', async () => {
      const { agent, token } = await login(STAFF);
      await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', pngBytes(2 * 1024 * 1024), {
          filename: 'exact.png',
          contentType: 'image/png',
        })
        .expect(200);
    });

    it('rejects a declared MIME outside the allowlist, and a wrong field name', async () => {
      const { agent, token } = await login(STAFF);

      await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', Buffer.from('GIF89a...........'), {
          filename: 'a.gif',
          contentType: 'image/gif',
        })
        .expect(400);

      await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('avatar', pngBytes(), 'a.png') // wrong part name
        .expect(400);
    });

    it('no file part at all is a 400', async () => {
      const { agent, token } = await login(STAFF);
      await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .field('nothing', 'here')
        .expect(400);
    });

    it('a storage failure is a 502 and leaves profilePictureUrl UNCHANGED', async () => {
      putAvatar.mockRejectedValue(new BadGatewayException('upstream'));
      const { agent, token } = await login(STAFF);

      await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', pngBytes(), 'me.png')
        .expect(502);

      const row = await prisma.systemUser.findUniqueOrThrow({
        where: { id: ids[STAFF] },
        select: { profilePictureUrl: true },
      });
      expect(row.profilePictureUrl).toBeNull();
    });

    it('re-uploading deletes the OLD object and returns the new URL', async () => {
      await prisma.systemUser.update({
        where: { id: ids[STAFF] },
        data: { profilePictureUrl: `${R2_BASE}/avatars/${ids[STAFF]}/old.png` },
      });
      const { agent, token } = await login(STAFF);

      await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', pngBytes(), 'me.png')
        .expect(200);

      expect(deleteObject).toHaveBeenCalledWith(
        `avatars/${ids[STAFF]}/old.png`,
      );
    });

    it('an old URL OUTSIDE our bucket is never deleted', async () => {
      await prisma.systemUser.update({
        where: { id: ids[STAFF] },
        data: { profilePictureUrl: 'https://cdn.elsewhere.com/avatars/x.png' },
      });
      const { agent, token } = await login(STAFF);

      await agent
        .post(url('/auth/system/me/avatar'))
        .set('x-csrf-token', token)
        .attach('file', pngBytes(), 'me.png')
        .expect(200);

      expect(deleteObject).not.toHaveBeenCalled();
    });

    it('requires the CSRF header (a multipart body cannot smuggle the token)', async () => {
      const { agent } = await login(STAFF);
      await agent
        .post(url('/auth/system/me/avatar'))
        .attach('file', pngBytes(), 'me.png')
        .expect(403);
    });
  });
});
