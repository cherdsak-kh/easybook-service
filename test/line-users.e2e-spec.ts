import type { INestApplication } from '@nestjs/common';
import { AppAccess, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { LineService } from '../src/line/line.service';
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

const SU_PREFIX = 'e2e-lusu-';
const LU_PREFIX = 'e2e-lu-';
const PASSWORD = 'e2e-correct-horse-battery';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const STAFF = `${SU_PREFIX}staff@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

// The exact status-change push copy (must match ACCESS_NOTIFICATION_MESSAGES in the service).
const ALLOWED_MSG =
  'ยินดีด้วย! บัญชีของคุณได้รับการอนุมัติการใช้งานเรียบร้อยแล้ว คุณสามารถกดปุ่มจองคิวที่เมนูด้านล่างเพื่อทำรายการได้ทันทีครับ 🎉';
const BLOCKED_MSG =
  'ขออภัย บัญชีการใช้งานของคุณถูกระงับสิทธิ์ชั่วคราวโดยผู้ดูแลระบบ หากมีข้อสงสัยกรุณาติดต่อเจ้าหน้าที่สถาบัน';

interface Session {
  agent: request.Agent;
  token: string;
}

interface RegistrationSummary {
  firstName: string;
  lastName: string;
  staffId: string;
  phone: string;
  departmentId: number;
  department: string;
  personnelRoleId: number;
  personnelRole: string;
}

interface LineUserBody {
  id: string;
  lineUserId: string;
  displayName: string | null;
  access: AppAccess;
  followedAt: string;
  registration: RegistrationSummary | null;
}

interface ListBody {
  data: LineUserBody[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** The LINE fixtures. All display names start with `Qwx` so `?search=Qwx` scopes to only these. */
const FIXTURES: Array<{
  lineUserId: string;
  displayName: string;
  access: AppAccess;
  deleted?: boolean;
}> = [
  {
    lineUserId: `${LU_PREFIX}pending`,
    displayName: 'QwxAlice Pending',
    access: AppAccess.PENDING,
  },
  {
    lineUserId: `${LU_PREFIX}allowed`,
    displayName: 'QwxBob Allowed',
    access: AppAccess.ALLOWED,
  },
  {
    lineUserId: `${LU_PREFIX}blocked`,
    displayName: 'QwxCarol Blocked',
    access: AppAccess.BLOCKED,
  },
  {
    lineUserId: `${LU_PREFIX}lower`,
    displayName: 'qwxeve lower',
    access: AppAccess.PENDING,
  },
  {
    lineUserId: `${LU_PREFIX}deleted`,
    displayName: 'QwxDave Deleted',
    access: AppAccess.PENDING,
    deleted: true,
  },
];

describe('LINE Users management (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let pushSpy: jest.SpyInstance;
  let linkSpy: jest.SpyInstance;

  const luIds: Record<string, string> = {};
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

  // Ids of the fixture option rows (the registration FK targets), refreshed each seed.
  const optionIds: { departmentId: number; personnelRoleId: number } = {
    departmentId: 0,
    personnelRoleId: 0,
  };
  const DEPT_NAME = `${LU_PREFIX}Engineering`;
  const ROLE_NAME = `${LU_PREFIX}Staff`;

  const purgeLineUsers = () =>
    // Cascade-deletes the registrations (FK onDelete: Cascade), so the option rows can then go.
    prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );

  const purgeOptions = async () => {
    // Safe only AFTER the registrations are gone (FK onDelete: Restrict).
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE "name" LIKE '${LU_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM personnel_roles WHERE "name" LIKE '${LU_PREFIX}%'`,
    );
  };

  /** Re-creates the fixture rows so each test starts from a known world. */
  const seed = async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeLineUsers();
    await purgeOptions();

    const dept = await prisma.department.create({
      data: { name: DEPT_NAME },
      select: { id: true },
    });
    const prole = await prisma.personnelRole.create({
      data: { name: ROLE_NAME },
      select: { id: true },
    });
    optionIds.departmentId = dept.id;
    optionIds.personnelRoleId = prole.id;

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

    for (const f of FIXTURES) {
      const created = await prisma.lineUser.create({
        data: {
          lineUserId: f.lineUserId,
          displayName: f.displayName,
          access: f.access,
          deletedAt: f.deleted ? new Date() : null,
        },
        select: { id: true },
      });
      luIds[f.lineUserId] = created.id;
    }

    // The ALLOWED fixture carries a registration so the list-embed can be asserted; the others
    // deliberately have none (registration: null in the row).
    await prisma.lineUserRegistration.create({
      data: {
        lineUserId: luIds[`${LU_PREFIX}allowed`],
        firstName: 'Bob',
        lastName: 'Allowed',
        staffId: `${LU_PREFIX}stid-allowed`,
        phone: '081-000-0000',
        departmentId: optionIds.departmentId,
        personnelRoleId: optionIds.personnelRoleId,
      },
    });
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);

    // updateAccess now applies the rich menu on LINE. Stub the LINE calls so the PATCH tests never
    // hit the real Messaging API — the switch behaviour is unit-tested; here we only need 200s.
    const line = app.get(LineService);
    jest.spyOn(line, 'findRichMenuId').mockResolvedValue('rm-e2e');
    linkSpy = jest
      .spyOn(line, 'linkRichMenuToUser')
      .mockResolvedValue(undefined);
    // Best-effort push on access change — stub it so the PATCH tests never hit the real Messaging API.
    pushSpy = jest.spyOn(line, 'push').mockResolvedValue(undefined);
  }, 60_000);

  beforeEach(async () => {
    await clearThrottleCounters(redis);
    await seed();
  });

  afterAll(async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeLineUsers();
    await purgeOptions();
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ─────────────────────────── authz ───────────────────────────

  it('AC-B1 — with no session, GET and PATCH return 401', async () => {
    const anon = request.agent(server());
    const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;

    await anon.get(url('/line-users')).expect(401);
    await anon
      .patch(url(`/line-users/${luIds[`${LU_PREFIX}pending`]}`))
      .set('x-csrf-token', token)
      .send({ access: AppAccess.ALLOWED })
      .expect(401);
  });

  it('AC-B7 — STAFF gets 403 on both routes (not 401)', async () => {
    const { agent, token } = await login(STAFF);
    await agent.get(url('/line-users')).expect(403);
    await agent
      .patch(url(`/line-users/${luIds[`${LU_PREFIX}pending`]}`))
      .set('x-csrf-token', token)
      .send({ access: AppAccess.BLOCKED })
      .expect(403);
  });

  it('AC-B1/B7 — both SUPER_ADMIN and ADMIN may list', async () => {
    for (const email of [SUPER, ADMIN]) {
      const { agent } = await login(email);
      await agent.get(url('/line-users')).expect(200);
    }
  });

  // ─────────────────────────── list ───────────────────────────

  describe('GET /line-users', () => {
    it('AC-B2 — returns the { data, meta } envelope with defaults page=1, limit=20, and only DTO fields', async () => {
      const { agent } = await login(ADMIN);
      const res = await agent.get(url('/line-users?search=Qwx')).expect(200);
      const body = res.body as ListBody;

      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(20);
      expect(body.meta.totalPages).toBe(Math.ceil(body.meta.total / 20));
      expect(body.data[0]).toHaveProperty('id');
      expect(body.data[0]).toHaveProperty('followedAt');
      expect(JSON.stringify(body)).not.toContain('deletedAt');
      expect(JSON.stringify(body)).not.toContain('language');
    });

    it('AC-B3 — limit=101, limit=0, page=0 and an unknown query param are each 400', async () => {
      const { agent } = await login(ADMIN);
      await agent.get(url('/line-users?limit=101')).expect(400);
      await agent.get(url('/line-users?limit=0')).expect(400);
      await agent.get(url('/line-users?page=0')).expect(400);
      await agent.get(url('/line-users?sort=name')).expect(400);
    });

    it('AC-B3 — a page beyond the last is 200 with empty data and truthful meta', async () => {
      const { agent } = await login(ADMIN);
      const res = await agent
        .get(url('/line-users?search=Qwx&page=9999'))
        .expect(200);
      const body = res.body as ListBody;
      expect(body.data).toEqual([]);
      expect(body.meta.page).toBe(9999);
    });

    it('AC-B4 — search is a case-insensitive substring on displayName', async () => {
      const { agent } = await login(ADMIN);
      const res = await agent
        .get(url('/line-users?search=qwxcarol&limit=100'))
        .expect(200);
      const ids = (res.body as ListBody).data.map((u) => u.lineUserId);
      expect(ids).toEqual([`${LU_PREFIX}blocked`]);
    });

    it('AC-B5 — the access filter narrows the list; an invalid value is 400', async () => {
      const { agent } = await login(ADMIN);

      const blocked = await agent
        .get(url('/line-users?search=Qwx&access=BLOCKED&limit=100'))
        .expect(200);
      const blockedIds = (blocked.body as ListBody).data.map(
        (u) => u.lineUserId,
      );
      expect(blockedIds).toEqual([`${LU_PREFIX}blocked`]);

      const pending = await agent
        .get(url('/line-users?search=Qwx&access=PENDING&limit=100'))
        .expect(200);
      const pendingIds = (pending.body as ListBody).data
        .map((u) => u.lineUserId)
        .sort();
      expect(pendingIds).toEqual(
        [`${LU_PREFIX}lower`, `${LU_PREFIX}pending`].sort(),
      );

      await agent.get(url('/line-users?access=NOPE')).expect(400);
    });

    it('AC-B11 — each row embeds the registration summary (or null), including the phone', async () => {
      const { agent } = await login(ADMIN);
      const res = await agent
        .get(url('/line-users?search=Qwx&limit=100'))
        .expect(200);
      const rows = (res.body as ListBody).data;

      const allowed = rows.find((u) => u.lineUserId === `${LU_PREFIX}allowed`);
      expect(allowed?.registration).toEqual({
        firstName: 'Bob',
        lastName: 'Allowed',
        staffId: `${LU_PREFIX}stid-allowed`,
        phone: '081-000-0000',
        // §B-8a additive: the summary now carries the raw FK ids (for the admin edit modal's
        // dropdown pre-select) alongside the RESOLVED option names.
        departmentId: optionIds.departmentId,
        department: DEPT_NAME,
        personnelRoleId: optionIds.personnelRoleId,
        personnelRole: ROLE_NAME,
      });

      // A follower with no registration renders gracefully as null (AC-F7 backend half).
      const pending = rows.find((u) => u.lineUserId === `${LU_PREFIX}pending`);
      expect(pending?.registration).toBeNull();

      // PO decision reversal: admins now see the phone to vet registrations.
      expect(allowed?.registration?.phone).toBe('081-000-0000');
      expect(JSON.stringify(res.body)).toContain('081-000-0000');
    });

    it('SC-B5 — a registration whose option was later soft-deleted still resolves the name', async () => {
      const { agent } = await login(ADMIN);

      // Soft-delete the referenced option (app-level soft delete = set deletedAt).
      await prisma.department.update({
        where: { id: optionIds.departmentId },
        data: { deletedAt: new Date() },
      });

      const res = await agent
        .get(url('/line-users?search=Qwx&limit=100'))
        .expect(200);
      const allowed = (res.body as ListBody).data.find(
        (u) => u.lineUserId === `${LU_PREFIX}allowed`,
      );
      // The FK row persists (only deletedAt set), so the name still resolves for display.
      expect(allowed?.registration?.department).toBe(DEPT_NAME);
    });

    it('AC-B6 — a soft-deleted LINE user never appears in data', async () => {
      const { agent } = await login(ADMIN);
      const res = await agent
        .get(url('/line-users?search=Qwx&limit=100'))
        .expect(200);
      const ids = (res.body as ListBody).data.map((u) => u.lineUserId);
      expect(ids).not.toContain(`${LU_PREFIX}deleted`);
      expect(ids.sort()).toEqual(
        [
          `${LU_PREFIX}allowed`,
          `${LU_PREFIX}blocked`,
          `${LU_PREFIX}lower`,
          `${LU_PREFIX}pending`,
        ].sort(),
      );
    });
  });

  // ─────────────────────────── patch ───────────────────────────

  describe('PATCH /line-users/:id', () => {
    const target = () => url(`/line-users/${luIds[`${LU_PREFIX}pending`]}`);

    it('AC-B8 — Block then Approve flips access, and a follow-up GET reflects it', async () => {
      const { agent, token } = await login(ADMIN);

      const blocked = await agent
        .patch(target())
        .set('x-csrf-token', token)
        .send({ access: AppAccess.BLOCKED })
        .expect(200);
      expect((blocked.body as LineUserBody).access).toBe(AppAccess.BLOCKED);

      const afterBlock = await agent
        .get(url('/line-users?search=QwxAlice&limit=100'))
        .expect(200);
      expect((afterBlock.body as ListBody).data[0].access).toBe(
        AppAccess.BLOCKED,
      );

      const allowed = await agent
        .patch(target())
        .set('x-csrf-token', token)
        .send({ access: AppAccess.ALLOWED })
        .expect(200);
      expect((allowed.body as LineUserBody).access).toBe(AppAccess.ALLOWED);
    });

    it('AC-B9 — a PATCH without an x-csrf-token is 403 and does not change state', async () => {
      const { agent } = await login(ADMIN);
      await agent
        .patch(target())
        .send({ access: AppAccess.BLOCKED })
        .expect(403);

      const row = await prisma.lineUser.findUnique({
        where: { id: luIds[`${LU_PREFIX}pending`] },
        select: { access: true },
      });
      expect(row?.access).toBe(AppAccess.PENDING);
    });

    it('AC-B10 — an unknown id and a soft-deleted id are byte-identical 404s revealing no deletion', async () => {
      const { agent, token } = await login(ADMIN);

      const unknown = await agent
        .patch(url('/line-users/never-existed'))
        .set('x-csrf-token', token)
        .send({ access: AppAccess.ALLOWED })
        .expect(404);
      const deleted = await agent
        .patch(url(`/line-users/${luIds[`${LU_PREFIX}deleted`]}`))
        .set('x-csrf-token', token)
        .send({ access: AppAccess.ALLOWED })
        .expect(404);

      expect(deleted.body).toEqual(unknown.body);
      expect(JSON.stringify(deleted.body)).not.toContain('deletedAt');

      // No state change: the soft-deleted row is still deleted and still PENDING.
      const row = await prisma.lineUser.findUnique({
        where: { id: luIds[`${LU_PREFIX}deleted`] },
        select: { access: true, deletedAt: true },
      });
      expect(row?.access).toBe(AppAccess.PENDING);
      expect(row?.deletedAt).not.toBeNull();
    });

    it('AC-B11 — a bad enum, an extra key, and an empty body are each 400', async () => {
      const { agent, token } = await login(ADMIN);
      const patch = (body: Record<string, unknown>) =>
        agent.patch(target()).set('x-csrf-token', token).send(body);

      await patch({ access: 'MAYBE' }).expect(400);
      await patch({ access: AppAccess.ALLOWED, note: 'x' }).expect(400);
      await patch({}).expect(400);
    });

    it('pushes the exact status copy to the LINE U… id, and a push failure does not 500 the PATCH', async () => {
      const { agent, token } = await login(ADMIN);
      const lineUserId = `${LU_PREFIX}pending`;

      pushSpy.mockClear();
      pushSpy.mockResolvedValue(undefined);
      await agent
        .patch(target())
        .set('x-csrf-token', token)
        .send({ access: AppAccess.ALLOWED })
        .expect(200);

      // Pushed to the LINE-side U… id (the fixture's lineUserId), NOT the cuid.
      expect(pushSpy).toHaveBeenCalledWith(lineUserId, [
        { type: 'text', text: ALLOWED_MSG },
      ]);

      // Best-effort: even when the push rejects, the PATCH still succeeds (no 500/502) and the
      // access change persists.
      pushSpy.mockClear();
      pushSpy.mockRejectedValueOnce(new Error('user blocked the bot'));
      const blocked = await agent
        .patch(target())
        .set('x-csrf-token', token)
        .send({ access: AppAccess.BLOCKED })
        .expect(200);
      expect((blocked.body as LineUserBody).access).toBe(AppAccess.BLOCKED);
      expect(pushSpy).toHaveBeenCalledWith(lineUserId, [
        { type: 'text', text: BLOCKED_MSG },
      ]);

      const row = await prisma.lineUser.findUnique({
        where: { id: luIds[lineUserId] },
        select: { access: true },
      });
      expect(row?.access).toBe(AppAccess.BLOCKED);
    });

    it('AC-B8 — a SUPER_ADMIN may also patch', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(target())
        .set('x-csrf-token', token)
        .send({ access: AppAccess.ALLOWED })
        .expect(200);
    });
  });

  // ───────── transition matrix + SUPER_ADMIN bypass (Item 3, AC-3.1/2/3/5/6) ─────────

  describe('PATCH /line-users/:id — ADMIN transition matrix', () => {
    const idFor = (suffix: string) => luIds[`${LU_PREFIX}${suffix}`];
    const patchAs = async (
      email: string,
      suffix: string,
      access: AppAccess,
    ) => {
      const { agent, token } = await login(email);
      return agent
        .patch(url(`/line-users/${idFor(suffix)}`))
        .set('x-csrf-token', token)
        .send({ access });
    };
    const accessOf = async (suffix: string) =>
      (
        await prisma.lineUser.findUnique({
          where: { id: idFor(suffix) },
          select: { access: true },
        })
      )?.access;

    // Each ✅ cell: the four PO pairs + the two idempotent same-state writes. Fixture `from` states:
    // pending=PENDING, allowed=ALLOWED, blocked=BLOCKED.
    it.each([
      ['pending', AppAccess.ALLOWED],
      ['pending', AppAccess.BLOCKED],
      ['allowed', AppAccess.BLOCKED],
      ['blocked', AppAccess.ALLOWED],
      ['allowed', AppAccess.ALLOWED],
      ['blocked', AppAccess.BLOCKED],
    ] as Array<[string, AppAccess]>)(
      'AC-3.1 — ADMIN may set %s → %s (200) and it persists',
      async (suffix, to) => {
        const res = await patchAs(ADMIN, suffix, to);
        expect(res.status).toBe(200);
        expect((res.body as LineUserBody).access).toBe(to);
        expect(await accessOf(suffix)).toBe(to);
      },
    );

    // Each ❌ cell: a target of PENDING/UNREGISTERED is forbidden for ADMIN → 403, no state change.
    it.each([
      ['pending', AppAccess.PENDING],
      ['pending', AppAccess.UNREGISTERED],
      ['allowed', AppAccess.PENDING],
      ['allowed', AppAccess.UNREGISTERED],
      ['blocked', AppAccess.PENDING],
      ['blocked', AppAccess.UNREGISTERED],
    ] as Array<[string, AppAccess]>)(
      'AC-3.2 — ADMIN may NOT set %s → %s (403) and nothing changes',
      async (suffix, to) => {
        const before = await accessOf(suffix);
        const res = await patchAs(ADMIN, suffix, to);
        expect(res.status).toBe(403);
        expect(await accessOf(suffix)).toBe(before);
      },
    );

    // SUPER_ADMIN bypasses the matrix: any→any on a live row, including forcing PENDING/UNREGISTERED.
    it.each([
      ['allowed', AppAccess.PENDING],
      ['blocked', AppAccess.UNREGISTERED],
      ['pending', AppAccess.PENDING],
    ] as Array<[string, AppAccess]>)(
      'AC-3.3 — SUPER_ADMIN may force %s → %s (200)',
      async (suffix, to) => {
        const res = await patchAs(SUPER, suffix, to);
        expect(res.status).toBe(200);
        expect(await accessOf(suffix)).toBe(to);
      },
    );

    it('AC-3.5 — for ADMIN a soft-deleted id is 404 even for a FORBIDDEN transition (404 before 403)', async () => {
      const { agent, token } = await login(ADMIN);

      // A forbidden target (PENDING) on a soft-deleted row must be 404, byte-identical to an unknown
      // id — 404 wins, so the matrix never leaks the row's existence.
      const deleted = await agent
        .patch(url(`/line-users/${idFor('deleted')}`))
        .set('x-csrf-token', token)
        .send({ access: AppAccess.PENDING })
        .expect(404);
      const unknown = await agent
        .patch(url('/line-users/never-existed'))
        .set('x-csrf-token', token)
        .send({ access: AppAccess.PENDING })
        .expect(404);
      expect(deleted.body).toEqual(unknown.body);

      // The soft-deleted row is untouched (still PENDING, still deleted).
      const row = await prisma.lineUser.findUnique({
        where: { id: idFor('deleted') },
        select: { access: true, deletedAt: true },
      });
      expect(row?.access).toBe(AppAccess.PENDING);
      expect(row?.deletedAt).not.toBeNull();
    });

    it('AC-3.6 — SUPER_ADMIN may force a soft-deleted user; DB persists, LINE side-effects are skipped, no 502', async () => {
      const { agent, token } = await login(SUPER);
      pushSpy.mockClear();
      linkSpy.mockClear();

      const res = await agent
        .patch(url(`/line-users/${idFor('deleted')}`))
        .set('x-csrf-token', token)
        .send({ access: AppAccess.ALLOWED })
        .expect(200);
      expect((res.body as LineUserBody).access).toBe(AppAccess.ALLOWED);

      // The DB row is the source of truth: access + derived richMenuType persisted, still soft-deleted.
      const row = await prisma.lineUser.findUnique({
        where: { id: idFor('deleted') },
        select: { access: true, richMenuType: true, deletedAt: true },
      });
      expect(row?.access).toBe(AppAccess.ALLOWED);
      expect(row?.richMenuType).toBe('TYPE_2');
      expect(row?.deletedAt).not.toBeNull();

      // Both LINE side-effects were skipped — the account is unreachable, so no push and no menu link.
      expect(linkSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });
  });

  // ───────── admin registration edit (Fix B, AC-B1..B12) ─────────

  describe('PATCH /line-users/:id/registration', () => {
    const regUrl = (suffix: string) =>
      url(`/line-users/${luIds[`${LU_PREFIX}${suffix}`]}/registration`);

    const validBody = () => ({
      firstName: 'Edited',
      lastName: 'Person',
      staffId: `${LU_PREFIX}stid-edited`,
      phone: '099-888-7777',
      departmentId: optionIds.departmentId,
      personnelRoleId: optionIds.personnelRoleId,
    });

    const regRowOf = (suffix: string) =>
      prisma.lineUserRegistration.findFirst({
        where: { lineUserId: luIds[`${LU_PREFIX}${suffix}`] },
        select: {
          firstName: true,
          lastName: true,
          staffId: true,
          phone: true,
          departmentId: true,
          personnelRoleId: true,
        },
      });

    const accessOf = async (suffix: string) =>
      (
        await prisma.lineUser.findUnique({
          where: { id: luIds[`${LU_PREFIX}${suffix}`] },
          select: { access: true },
        })
      )?.access;

    it('AC-B2/B9 — ADMIN edits all six fields; DB persists them, access is unchanged, no LINE side-effect', async () => {
      const { agent, token } = await login(ADMIN);
      pushSpy.mockClear();
      linkSpy.mockClear();

      const res = await agent
        .patch(regUrl('allowed'))
        .set('x-csrf-token', token)
        .send(validBody())
        .expect(200);

      const body = res.body as LineUserBody;
      // The response is a LineUserResponseDto whose summary carries the edited values + the FK ids.
      expect(body.access).toBe(AppAccess.ALLOWED);
      expect(body.registration).toMatchObject({
        firstName: 'Edited',
        lastName: 'Person',
        staffId: `${LU_PREFIX}stid-edited`,
        phone: '099-888-7777',
        departmentId: optionIds.departmentId,
        personnelRoleId: optionIds.personnelRoleId,
      });

      // All six fields persisted.
      expect(await regRowOf('allowed')).toEqual({
        firstName: 'Edited',
        lastName: 'Person',
        staffId: `${LU_PREFIX}stid-edited`,
        phone: '099-888-7777',
        departmentId: optionIds.departmentId,
        personnelRoleId: optionIds.personnelRoleId,
      });
      // Orthogonal to the access matrix: access untouched, and NO rich-menu apply / push fired.
      expect(await accessOf('allowed')).toBe(AppAccess.ALLOWED);
      expect(linkSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('AC-B2 — SUPER_ADMIN may also edit a (live) registration', async () => {
      const { agent, token } = await login(SUPER);
      await agent
        .patch(regUrl('allowed'))
        .set('x-csrf-token', token)
        .send({ ...validBody(), firstName: 'BySuper' })
        .expect(200);
      const row = await regRowOf('allowed');
      expect(row?.firstName).toBe('BySuper');
    });

    it('AC-B5 — re-submitting the row’s OWN current staffId is not a false 409', async () => {
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(regUrl('allowed'))
        .set('x-csrf-token', token)
        // keep the fixture's existing staffId, change only the name
        .send({
          ...validBody(),
          staffId: `${LU_PREFIX}stid-allowed`,
          firstName: 'SameStaffId',
        })
        .expect(200);
      const row = await regRowOf('allowed');
      expect(row?.staffId).toBe(`${LU_PREFIX}stid-allowed`);
      expect(row?.firstName).toBe('SameStaffId');
    });

    it('AC-B5 — a staffId held by ANOTHER registration is a 409', async () => {
      // Give the PENDING fixture its own registration with a distinct staffId.
      await prisma.lineUserRegistration.create({
        data: {
          lineUserId: luIds[`${LU_PREFIX}pending`],
          firstName: 'Other',
          lastName: 'Holder',
          staffId: `${LU_PREFIX}stid-other`,
          phone: '081-111-1111',
          departmentId: optionIds.departmentId,
          personnelRoleId: optionIds.personnelRoleId,
        },
      });

      const { agent, token } = await login(ADMIN);
      await agent
        .patch(regUrl('allowed'))
        .set('x-csrf-token', token)
        .send({ ...validBody(), staffId: `${LU_PREFIX}stid-other` })
        .expect(409);

      // The clash left the row unchanged.
      expect((await regRowOf('allowed'))?.staffId).toBe(
        `${LU_PREFIX}stid-allowed`,
      );
    });

    it('AC-B6 — a system-reserved option is 400 for BOTH ADMIN and SUPER_ADMIN (reserved-for-everyone)', async () => {
      const reserved = await prisma.department.create({
        data: { name: `${LU_PREFIX}Reserved`, isSystemReserved: true },
        select: { id: true },
      });

      for (const email of [ADMIN, SUPER]) {
        const { agent, token } = await login(email);
        await agent
          .patch(regUrl('allowed'))
          .set('x-csrf-token', token)
          .send({ ...validBody(), departmentId: reserved.id })
          .expect(400);
      }
      // Never assigned — the row keeps its original department.
      expect((await regRowOf('allowed'))?.departmentId).toBe(
        optionIds.departmentId,
      );
    });

    it('AC-B6 — a soft-deleted option id is 400', async () => {
      const deletedDept = await prisma.department.create({
        data: { name: `${LU_PREFIX}Gone`, deletedAt: new Date() },
        select: { id: true },
      });
      const { agent, token } = await login(ADMIN);
      await agent
        .patch(regUrl('allowed'))
        .set('x-csrf-token', token)
        .send({ ...validBody(), departmentId: deletedDept.id })
        .expect(400);
    });

    it('AC-B7 — a user with no registration is a 404 (distinct message), never a 500', async () => {
      const { agent, token } = await login(ADMIN);
      const res = await agent
        .patch(regUrl('pending'))
        .set('x-csrf-token', token)
        .send(validBody())
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        'This LINE user has no registration to edit.',
      );
    });

    it('AC-B8 — an unknown id is 404, byte-identical to a soft-deleted id under ADMIN', async () => {
      const { agent, token } = await login(ADMIN);
      const unknown = await agent
        .patch(url('/line-users/never-existed/registration'))
        .set('x-csrf-token', token)
        .send(validBody())
        .expect(404);
      const deleted = await agent
        .patch(regUrl('deleted'))
        .set('x-csrf-token', token)
        .send(validBody())
        .expect(404);
      // The soft-deleted 404 reveals nothing an unknown id does not (no existence/deletion leak).
      expect(deleted.body).toEqual(unknown.body);
      expect(JSON.stringify(deleted.body)).not.toContain('deletedAt');
    });

    it('AC-B8 — SUPER_ADMIN may edit a soft-deleted user’s registration; persists, no LINE side-effect', async () => {
      // Give the soft-deleted fixture a registration to edit.
      await prisma.lineUserRegistration.create({
        data: {
          lineUserId: luIds[`${LU_PREFIX}deleted`],
          firstName: 'Ghost',
          lastName: 'User',
          staffId: `${LU_PREFIX}stid-deleted`,
          phone: '082-222-2222',
          departmentId: optionIds.departmentId,
          personnelRoleId: optionIds.personnelRoleId,
        },
      });
      pushSpy.mockClear();
      linkSpy.mockClear();

      const { agent, token } = await login(SUPER);
      await agent
        .patch(regUrl('deleted'))
        .set('x-csrf-token', token)
        .send({ ...validBody(), firstName: 'Revised' })
        .expect(200);

      const row = await regRowOf('deleted');
      expect(row?.firstName).toBe('Revised');
      // Still soft-deleted, and no LINE side-effect fired (no 502/500 path here).
      const lu = await prisma.lineUser.findUnique({
        where: { id: luIds[`${LU_PREFIX}deleted`] },
        select: { deletedAt: true },
      });
      expect(lu?.deletedAt).not.toBeNull();
      expect(linkSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('AC-B3/B4 — a lineUserId key, a blank field, and a bad phone are each 400', async () => {
      const { agent, token } = await login(ADMIN);
      const patch = (body: Record<string, unknown>) =>
        agent.patch(regUrl('allowed')).set('x-csrf-token', token).send(body);

      await patch({ ...validBody(), lineUserId: 'U-evil' }).expect(400);
      await patch({ ...validBody(), firstName: '   ' }).expect(400);
      await patch({ ...validBody(), phone: 'not a phone!!' }).expect(400);
    });

    it('AC-B9 — a PATCH without x-csrf-token is 403 and does not change the registration', async () => {
      const { agent } = await login(ADMIN);
      await agent.patch(regUrl('allowed')).send(validBody()).expect(403);
      expect((await regRowOf('allowed'))?.firstName).toBe('Bob');
    });

    it('AC-B2 — STAFF is 403 and no session is 401', async () => {
      const staff = await login(STAFF);
      await staff.agent
        .patch(regUrl('allowed'))
        .set('x-csrf-token', staff.token)
        .send(validBody())
        .expect(403);

      const anon = request.agent(server());
      const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
      const anonToken = (csrf.body as { csrfToken: string }).csrfToken;
      await anon
        .patch(regUrl('allowed'))
        .set('x-csrf-token', anonToken)
        .send(validBody())
        .expect(401);
    });

    it('AC-B9 — registration edits and access changes are independently governed (neither triggers the other)', async () => {
      const { agent, token } = await login(ADMIN);

      // An access change on the same user does not alter the registration fields.
      await agent
        .patch(url(`/line-users/${luIds[`${LU_PREFIX}allowed`]}`))
        .set('x-csrf-token', token)
        .send({ access: AppAccess.BLOCKED })
        .expect(200);
      expect((await regRowOf('allowed'))?.firstName).toBe('Bob');

      // A registration edit on the same user does not alter access (still BLOCKED from above).
      await agent
        .patch(regUrl('allowed'))
        .set('x-csrf-token', token)
        .send({ ...validBody(), firstName: 'Independent' })
        .expect(200);
      expect(await accessOf('allowed')).toBe(AppAccess.BLOCKED);
    });
  });
});
