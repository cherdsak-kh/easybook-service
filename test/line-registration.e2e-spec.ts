// The LINE Login channel id the guard verifies id_token `aud` against. MUST be set before the app
// boots (ConfigModule reads process.env at forRoot). Digits only, per env.validation.
process.env.LINE_LOGIN_CHANNEL_ID =
  process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';

import type { INestApplication } from '@nestjs/common';
import { AppAccess } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { API_BASE_PATH } from '../src/common/api.constants';
import { LineService } from '../src/line/line.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, prismaOf, redisOf, waitForRedis } from './e2e-app';

jest.setTimeout(120_000);

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const LU_PREFIX = 'e2ereg-';
const url = (path: string) => `${API_BASE_PATH}${path}`;

const DEPT_NAME = `${LU_PREFIX}Computer Science`;
const ROLE_NAME = `${LU_PREFIX}Teacher`;
const DEPT2_NAME = `${LU_PREFIX}Mathematics`;
const DELETED_DEPT_NAME = `${LU_PREFIX}Retired Dept`;

// The exact "registration received" push copy (must match ACCESS_NOTIFICATION_MESSAGES / PENDING).
const PENDING_MSG =
  'ระบบได้รับข้อมูลการลงทะเบียนของคุณแล้ว เจ้าหน้าที่กำลังดำเนินการตรวจสอบข้อมูลกรุณารอสักครู่ครับ ⏳';

const optionIds = {
  departmentId: '',
  personnelRoleId: '',
  department2Id: '',
  deletedDepartmentId: '',
};

const validBody = (staffId: string) => ({
  firstName: 'Somchai',
  lastName: 'Jaidee',
  staffId,
  phone: '081-234-5678',
  departmentId: optionIds.departmentId,
  personnelRoleId: optionIds.personnelRoleId,
});

interface StatusBody {
  access: AppAccess;
  registration: {
    id: string;
    staffId: string;
    phone: string;
    departmentId: string;
    department: string;
    personnelRoleId: string;
    personnelRole: string;
  } | null;
}

interface OptionsBody {
  departments: Array<{ id: string; name: string }>;
  personnelRoles: Array<{ id: string; name: string }>;
}

/**
 * The verify-endpoint mock. `id_token=invalid` → 400 (LINE rejects → 401 from the guard); any other
 * token → 200 with a payload whose `sub` is `currentSub`, `aud` is our channel. Never hits real LINE.
 */
let currentSub = '';
const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

describe('LINE registration + status (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let pushSpy: jest.SpyInstance;
  const server = () => app.getHttpServer();

  const purgeLineUsers = () =>
    prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );

  const purgeOptions = async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE "name" LIKE '${LU_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM personnel_roles WHERE "name" LIKE '${LU_PREFIX}%'`,
    );
  };

  const seedOptions = async () => {
    const dept = await prisma.department.create({
      data: { name: DEPT_NAME },
      select: { id: true },
    });
    const dept2 = await prisma.department.create({
      data: { name: DEPT2_NAME },
      select: { id: true },
    });
    const deletedDept = await prisma.department.create({
      data: { name: DELETED_DEPT_NAME, deletedAt: new Date() },
      select: { id: true },
    });
    const role = await prisma.personnelRole.create({
      data: { name: ROLE_NAME },
      select: { id: true },
    });
    optionIds.departmentId = dept.id;
    optionIds.department2Id = dept2.id;
    optionIds.deletedDepartmentId = deletedDept.id;
    optionIds.personnelRoleId = role.id;
  };

  beforeAll(async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      const body = init?.body as URLSearchParams | undefined;
      const token = body?.get('id_token');
      if (token === 'invalid') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ error: 'invalid_request' }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            iss: 'https://access.line.me',
            sub: currentSub,
            aud: CHANNEL_ID,
            exp: futureExp(),
          }),
      } as Response);
    });

    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);

    // Best-effort push fires on register (PENDING copy) — stub it so tests never hit real LINE.
    pushSpy = jest
      .spyOn(app.get(LineService), 'push')
      .mockResolvedValue(undefined);

    await purgeLineUsers();
    await purgeOptions();
    await seedOptions();
  }, 60_000);

  beforeEach(async () => {
    await purgeLineUsers();
  });

  afterAll(async () => {
    await purgeLineUsers();
    await purgeOptions();
    jest.restoreAllMocks();
    await app.close();
  });

  const bearer = (token = 'good-token') => `Bearer ${token}`;

  const registerPending = async (sub: string, staffId: string) => {
    currentSub = sub;
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send(validBody(staffId))
      .expect(201);
  };

  // ─────────────────────────── auth (guard) ───────────────────────────

  it('AC-B4 — GET /status with no Authorization header is 401', async () => {
    await request(server()).get(url('/line-users/status')).expect(401);
  });

  it('AC-B4 — GET /status with an invalid token is 401 (LINE rejected)', async () => {
    currentSub = `${LU_PREFIX}U-invalid`;
    await request(server())
      .get(url('/line-users/status'))
      .set('Authorization', bearer('invalid'))
      .expect(401);
  });

  it('AC-B4 — POST /register with no token is 401 and writes nothing', async () => {
    await request(server())
      .post(url('/line-users/register'))
      .send(validBody(`${LU_PREFIX}stid-noauth`))
      .expect(401);
    const count = await prisma.lineUserRegistration.count({
      where: { staffId: `${LU_PREFIX}stid-noauth` },
    });
    expect(count).toBe(0);
  });

  // ─────────────────────────── options ───────────────────────────

  it('SC-B7 — GET /registration/options returns non-deleted options, name ASC, bearer-guarded', async () => {
    await request(server())
      .get(url('/line-users/registration/options'))
      .expect(401);

    currentSub = `${LU_PREFIX}U-opts`;
    const res = await request(server())
      .get(url('/line-users/registration/options'))
      .set('Authorization', bearer())
      .expect(200);
    const body = res.body as OptionsBody;

    const deptNames = body.departments.map((d) => d.name);
    expect(deptNames).toContain(DEPT_NAME);
    expect(deptNames).toContain(DEPT2_NAME);
    // The soft-deleted option is hidden.
    expect(deptNames).not.toContain(DELETED_DEPT_NAME);
    expect(body.personnelRoles.map((r) => r.name)).toContain(ROLE_NAME);

    // name ASC (stable) — DEPT2 (Mathematics) sorts after DEPT (Computer Science).
    const idxCs = deptNames.indexOf(DEPT_NAME);
    const idxMath = deptNames.indexOf(DEPT2_NAME);
    expect(idxCs).toBeLessThan(idxMath);
  });

  // ─────────────────────────── status ───────────────────────────

  it('AC-B1 — a LIFF-first caller gets a fresh UNREGISTERED status + null registration', async () => {
    currentSub = `${LU_PREFIX}U-fresh`;
    const res = await request(server())
      .get(url('/line-users/status'))
      .set('Authorization', bearer())
      .expect(200);
    const body = res.body as StatusBody;
    expect(body.access).toBe(AppAccess.UNREGISTERED);
    expect(body.registration).toBeNull();

    const row = await prisma.lineUser.findFirst({
      where: { lineUserId: currentSub },
      select: { access: true, richMenuType: true },
    });
    expect(row?.access).toBe(AppAccess.UNREGISTERED);
    expect(row?.richMenuType).toBe('TYPE_1');
  });

  // ─────────────────────────── register ───────────────────────────

  it('AC-B3 — POST /register creates the registration, flips to PENDING (resolved names), no CSRF', async () => {
    currentSub = `${LU_PREFIX}U-reg`;
    pushSpy.mockClear();
    // No x-csrf-token header sent → proves the CSRF exemption for this bearer endpoint.
    const res = await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send(validBody(`${LU_PREFIX}stid-1`))
      .expect(201);
    const body = res.body as StatusBody;
    expect(body.access).toBe(AppAccess.PENDING);
    expect(body.registration?.staffId).toBe(`${LU_PREFIX}stid-1`);
    expect(body.registration?.departmentId).toBe(optionIds.departmentId);
    expect(body.registration?.department).toBe(DEPT_NAME);
    expect(body.registration?.personnelRole).toBe(ROLE_NAME);

    // Best-effort PENDING push fired, to the caller's LINE U… id (the verified sub), not the cuid.
    expect(pushSpy).toHaveBeenCalledWith(currentSub, [
      { type: 'text', text: PENDING_MSG },
    ]);

    const row = await prisma.lineUser.findFirst({
      where: { lineUserId: currentSub },
      select: { access: true, richMenuType: true },
    });
    expect(row?.access).toBe(AppAccess.PENDING);
    expect(row?.richMenuType).toBe('TYPE_1');
  });

  it('SC-B6 — register with a deleted/unknown option id is 400 and writes nothing', async () => {
    currentSub = `${LU_PREFIX}U-badopt`;
    // A soft-deleted department id → 400.
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send({
        ...validBody(`${LU_PREFIX}stid-badopt`),
        departmentId: optionIds.deletedDepartmentId,
      })
      .expect(400);
    // An unknown personnel-role id → 400.
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send({
        ...validBody(`${LU_PREFIX}stid-badopt`),
        personnelRoleId: 'no-such-role',
      })
      .expect(400);

    const count = await prisma.lineUserRegistration.count({
      where: { staffId: `${LU_PREFIX}stid-badopt` },
    });
    expect(count).toBe(0);
  });

  it('AC-B5 — registering twice for the same LINE user is a 409', async () => {
    await registerPending(`${LU_PREFIX}U-dup`, `${LU_PREFIX}stid-dup1`);
    currentSub = `${LU_PREFIX}U-dup`;
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send(validBody(`${LU_PREFIX}stid-dup2`))
      .expect(409);
  });

  it('SC-B1 — a staffId already used by someone else is a 409', async () => {
    const sharedId = `${LU_PREFIX}stid-shared`;
    await registerPending(`${LU_PREFIX}U-a`, sharedId);

    currentSub = `${LU_PREFIX}U-b`;
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send(validBody(sharedId))
      .expect(409);
  });

  it('AC-B6 — validation: a blank field, a bad phone, and an extra key are each 400', async () => {
    currentSub = `${LU_PREFIX}U-val`;
    const post = (body: Record<string, unknown>) =>
      request(server())
        .post(url('/line-users/register'))
        .set('Authorization', bearer())
        .send(body);

    await post({ ...validBody(`${LU_PREFIX}stid-v`), firstName: '   ' }).expect(
      400,
    );
    await post({ ...validBody(`${LU_PREFIX}stid-v`), phone: 'nope!!' }).expect(
      400,
    );
    // A client-supplied lineUserId is rejected (impersonation guard + forbidNonWhitelisted).
    await post({
      ...validBody(`${LU_PREFIX}stid-v`),
      lineUserId: 'U-evil',
    }).expect(400);
  });

  // ─────────────────────── PENDING self-edit (PATCH /registration) ───────────────────────

  it('SC-B8 — a PENDING caller edits all fields, stays PENDING, sends no push', async () => {
    await registerPending(`${LU_PREFIX}U-edit`, `${LU_PREFIX}stid-edit`);
    currentSub = `${LU_PREFIX}U-edit`;
    pushSpy.mockClear();

    const res = await request(server())
      .patch(url('/line-users/registration'))
      .set('Authorization', bearer())
      .send({
        ...validBody(`${LU_PREFIX}stid-edit`), // re-submitting own staffId is fine
        firstName: 'Somchai-Edited',
        departmentId: optionIds.department2Id,
      })
      .expect(200);
    const body = res.body as StatusBody;
    expect(body.access).toBe(AppAccess.PENDING);
    expect(body.registration?.department).toBe(DEPT2_NAME);

    // No push on a field-edit.
    expect(pushSpy).not.toHaveBeenCalled();

    // access + richMenuType untouched.
    const row = await prisma.lineUser.findFirst({
      where: { lineUserId: currentSub },
      select: { access: true, richMenuType: true },
    });
    expect(row?.access).toBe(AppAccess.PENDING);
    expect(row?.richMenuType).toBe('TYPE_1');
  });

  it('SC-B9 — the PATCH by a non-PENDING caller (ALLOWED/BLOCKED/UNREGISTERED) is 403 with no write', async () => {
    // UNREGISTERED: a LIFF-first caller who never registered.
    currentSub = `${LU_PREFIX}U-unreg`;
    await request(server())
      .get(url('/line-users/status'))
      .set('Authorization', bearer())
      .expect(200); // creates the UNREGISTERED row
    await request(server())
      .patch(url('/line-users/registration'))
      .set('Authorization', bearer())
      .send(validBody(`${LU_PREFIX}stid-unreg`))
      .expect(403);

    // ALLOWED / BLOCKED: register then flip access directly, expect 403 and unchanged first name.
    for (const access of [AppAccess.ALLOWED, AppAccess.BLOCKED]) {
      const sub = `${LU_PREFIX}U-${access}`;
      await registerPending(sub, `${LU_PREFIX}stid-${access}`);
      await prisma.lineUser.updateMany({
        where: { lineUserId: sub },
        data: { access },
      });
      currentSub = sub;
      await request(server())
        .patch(url('/line-users/registration'))
        .set('Authorization', bearer())
        .send({ ...validBody(`${LU_PREFIX}stid-${access}`), firstName: 'Nope' })
        .expect(403);

      const reg = await prisma.lineUserRegistration.findFirst({
        where: { staffId: `${LU_PREFIX}stid-${access}` },
        select: { firstName: true },
      });
      expect(reg?.firstName).toBe('Somchai'); // no partial write
    }
  });

  it('SC-B10 — the PATCH enforces validation: body lineUserId → 400, deleted option → 400, foreign staffId → 409', async () => {
    await registerPending(`${LU_PREFIX}U-ev`, `${LU_PREFIX}stid-ev`);
    // A different PENDING user owns another staffId.
    await registerPending(`${LU_PREFIX}U-other`, `${LU_PREFIX}stid-other`);

    currentSub = `${LU_PREFIX}U-ev`;
    const patch = (body: Record<string, unknown>) =>
      request(server())
        .patch(url('/line-users/registration'))
        .set('Authorization', bearer())
        .send(body);

    await patch({
      ...validBody(`${LU_PREFIX}stid-ev`),
      lineUserId: 'U-evil',
    }).expect(400);
    await patch({
      ...validBody(`${LU_PREFIX}stid-ev`),
      departmentId: optionIds.deletedDepartmentId,
    }).expect(400);
    // Colliding with ANOTHER registration's staffId → 409.
    await patch(validBody(`${LU_PREFIX}stid-other`)).expect(409);
  });

  it('SC-6 — PATCH /line-users/registration reaches the CLIENT controller (200 with a PENDING bearer), not admin PATCH :id', async () => {
    await registerPending(`${LU_PREFIX}U-collide`, `${LU_PREFIX}stid-collide`);
    currentSub = `${LU_PREFIX}U-collide`;

    // With a valid LINE bearer (NOT a session cookie), the literal `registration` route wins and
    // returns 200. If it were shadowed by the admin `PATCH /line-users/:id` (SessionGuard), a bearer
    // token would yield 401, never 200 — so this 200 proves the collision fix.
    await request(server())
      .patch(url('/line-users/registration'))
      .set('Authorization', bearer())
      .send(validBody(`${LU_PREFIX}stid-collide`))
      .expect(200);

    // With no bearer at all, the client guard rejects (401) — the client controller is in the path.
    await request(server())
      .patch(url('/line-users/registration'))
      .send(validBody(`${LU_PREFIX}stid-collide`))
      .expect(401);
  });
});
