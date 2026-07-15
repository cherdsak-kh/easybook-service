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

// The exact "registration received" push copy (must match ACCESS_NOTIFICATION_MESSAGES / PENDING).
const PENDING_MSG =
  'ระบบได้รับข้อมูลการลงทะเบียนของคุณแล้ว เจ้าหน้าที่กำลังดำเนินการตรวจสอบข้อมูลกรุณารอสักครู่ครับ ⏳';

const VALID_BODY = {
  firstName: 'Somchai',
  lastName: 'Jaidee',
  studentStaffId: `${LU_PREFIX}stid-1`,
  phone: '081-234-5678',
  department: 'Computer Science',
  role: 'Student',
};

interface StatusBody {
  access: AppAccess;
  registration: {
    id: string;
    studentStaffId: string;
    phone: string;
  } | null;
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

  const purge = () =>
    prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );

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
  }, 60_000);

  beforeEach(async () => {
    await purge();
  });

  afterAll(async () => {
    await purge();
    jest.restoreAllMocks();
    await app.close();
  });

  const bearer = (token = 'good-token') => `Bearer ${token}`;

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
      .send(VALID_BODY)
      .expect(401);
    const count = await prisma.lineUserRegistration.count({
      where: { studentStaffId: VALID_BODY.studentStaffId },
    });
    expect(count).toBe(0);
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

    // The get-or-create really created the row with the UNREGISTERED default (AC-B1).
    const row = await prisma.lineUser.findFirst({
      where: { lineUserId: currentSub },
      select: { access: true, richMenuType: true },
    });
    expect(row?.access).toBe(AppAccess.UNREGISTERED);
    expect(row?.richMenuType).toBe('TYPE_1');
  });

  // ─────────────────────────── register ───────────────────────────

  it('AC-B3 — POST /register creates the registration, flips access to PENDING, and needs no CSRF token', async () => {
    currentSub = `${LU_PREFIX}U-reg`;
    pushSpy.mockClear();
    // No x-csrf-token header sent → proves the CSRF exemption for this bearer endpoint.
    const res = await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send(VALID_BODY)
      .expect(201);
    const body = res.body as StatusBody;
    expect(body.access).toBe(AppAccess.PENDING);
    expect(body.registration?.studentStaffId).toBe(VALID_BODY.studentStaffId);
    expect(body.registration?.phone).toBe(VALID_BODY.phone);

    // Best-effort PENDING push fired, to the caller's LINE U… id (the verified sub), not the cuid.
    expect(pushSpy).toHaveBeenCalledWith(currentSub, [
      { type: 'text', text: PENDING_MSG },
    ]);

    // Rich menu stays TYPE_1 through registration.
    const row = await prisma.lineUser.findFirst({
      where: { lineUserId: currentSub },
      select: { access: true, richMenuType: true },
    });
    expect(row?.access).toBe(AppAccess.PENDING);
    expect(row?.richMenuType).toBe('TYPE_1');

    // A follow-up /status echoes the PENDING state + registration.
    const status = await request(server())
      .get(url('/line-users/status'))
      .set('Authorization', bearer())
      .expect(200);
    expect((status.body as StatusBody).access).toBe(AppAccess.PENDING);
  });

  it('AC-B5 — registering twice for the same LINE user is a 409', async () => {
    currentSub = `${LU_PREFIX}U-dup`;
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send({ ...VALID_BODY, studentStaffId: `${LU_PREFIX}stid-dup1` })
      .expect(201);
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send({ ...VALID_BODY, studentStaffId: `${LU_PREFIX}stid-dup2` })
      .expect(409);
  });

  it('AC-B2 — a studentStaffId already used by someone else is a 409', async () => {
    const sharedId = `${LU_PREFIX}stid-shared`;

    currentSub = `${LU_PREFIX}U-a`;
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send({ ...VALID_BODY, studentStaffId: sharedId })
      .expect(201);

    currentSub = `${LU_PREFIX}U-b`;
    await request(server())
      .post(url('/line-users/register'))
      .set('Authorization', bearer())
      .send({ ...VALID_BODY, studentStaffId: sharedId })
      .expect(409);
  });

  it('AC-B6 — validation: a blank field, a bad phone, and an extra key are each 400', async () => {
    currentSub = `${LU_PREFIX}U-val`;
    const post = (body: Record<string, unknown>) =>
      request(server())
        .post(url('/line-users/register'))
        .set('Authorization', bearer())
        .send(body);

    await post({ ...VALID_BODY, firstName: '   ' }).expect(400);
    await post({ ...VALID_BODY, phone: 'nope!!' }).expect(400);
    // A client-supplied lineUserId is rejected (impersonation guard + forbidNonWhitelisted).
    await post({ ...VALID_BODY, lineUserId: 'U-evil' }).expect(400);
  });
});
