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
  department: string;
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
    jest.spyOn(line, 'linkRichMenuToUser').mockResolvedValue(undefined);
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
        // department + personnelRole are the RESOLVED option names, not ids.
        department: DEPT_NAME,
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
});
