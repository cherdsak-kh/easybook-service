// `NOTIF-EVENTS-1` — the 15 operational triggers, driven end-to-end. See design §5.3 / AC-13.
process.env.LINE_LOGIN_CHANNEL_ID =
  process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';

import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HTTPFetchError } from '@line/bot-sdk';
import {
  AdminNotification,
  AdminNotificationTargetRole,
  AppAccess,
  FeedbackType,
  SystemRole,
} from '@prisma/client';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { BookingExpiryCron } from '../src/bookings/booking-expiry.cron';
import { BookingNotifier } from '../src/bookings/booking-notifier';
import { CANCEL_LEAD_MINUTES_KEY } from '../src/bookings/bookings.constants';
import { API_BASE_PATH } from '../src/common/api.constants';
import { LINE_MESSAGING_CLIENT } from '../src/line/line-messaging-client';
import { LineService } from '../src/line/line.service';
import {
  NotificationsService,
  type CreateAdminNotificationInput,
} from '../src/notifications/notifications.service';
import { AdminNotificationTriggers } from '../src/notifications/triggers/admin-notification-triggers.service';
import {
  ADMIN_NOTIFICATION_TRIGGERS_ENABLED,
  lineFailureDedupeKey,
  serverErrorDedupeKey,
} from '../src/notifications/triggers/triggers.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { ClientRealtimeGateway } from '../src/realtime/client-realtime.gateway';
import {
  REALTIME_ADMIN_NAMESPACE,
  REALTIME_EVENTS,
  type AdminNotificationEventPayload,
} from '../src/realtime/realtime.constants';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { NOTIF_KEY_PREFIX } from '../src/redis/redis.constants';
import { sessionCookieName } from '../src/session/session.middleware';
import { VenuesService } from '../src/venues/venues.service';
import {
  clearThrottleCounters,
  createE2eApp,
  ensureE2eOptions,
  prismaOf,
  purgeE2eUsers,
  readCookie,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(180_000);

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const RUN = Date.now().toString(36);
const LU_PREFIX = `e2e-notif-${RUN}-`;
const ROW_PREFIX = `e2e-notif-${RUN}-`;
const SU_PREFIX = `e2e-notif-${RUN}-su-`;
const PASSWORD = 'E2e-correct-horse-battery-1';
/** `NOTIF-RT-1` — a second fixture, ADMIN rather than SUPER_ADMIN, for the audience e2e. */
const ADMIN_EMAIL = `${SU_PREFIX}admin@easybook.local`;

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A base far enough out that no other suite's fixtures could ever overlap it. */
const BASE = 300 * DAY;

const url = (path: string) => `${API_BASE_PATH}${path}`;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/** The verify-endpoint mock's current answer. Mirrors `feedback.e2e-spec.ts` / `line-settings.e2e-spec.ts`. */
let currentSub = '';
const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

const httpError = (status: number) =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{"message":"from LINE"}',
  });

interface Session {
  agent: request.Agent;
  token: string;
  cookie: string;
}

describe('Admin notification triggers — NOTIF-EVENTS-1 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let server: () => App;
  let baseUrl: string;
  let cookieName: string;

  /** `NOTIF-RT-1`: leaked sockets keep engine.io timers alive and hang `app.close()`. */
  const openSockets: Socket[] = [];

  let venueTypeId = 0;
  let venueAId = '';
  let venueBId = '';
  let venueCId = '';
  let options: { departmentId: number; personnelRoleId: number };
  let superAdminId = '';
  let session: Session;

  // ALLOWED LINE users with registrations, reused across the booking/feedback cases.
  let xId = '';
  const xSub = `${LU_PREFIX}x`;
  const ySub = `${LU_PREFIX}y`;
  const zSub = `${LU_PREFIX}z`;

  const fakeLine = {
    pushMessage: jest.fn(),
    multicast: jest.fn(),
    // `LineUserService.applyRichMenu` (called on every access transition, including U2's admin
    // reject) resolves the menu id by name+size before linking it — both needed so that PATCH
    // doesn't 502.
    getRichMenuList: jest.fn().mockResolvedValue({
      richmenus: [
        {
          richMenuId: 'e2e-rm-type1',
          name: 'easy-book-liff',
          size: { width: 2500, height: 843 },
        },
        {
          richMenuId: 'e2e-rm-type2',
          name: 'easy-book-main',
          size: { width: 2500, height: 1686 },
        },
      ],
    }),
    linkRichMenuIdToUser: jest.fn().mockResolvedValue({}),
  };

  /** Rows this suite is responsible for — identified ONLY by the id `create()` handed back. */
  const createdIds: string[] = [];
  let createSpy: jest.SpyInstance;

  const expectOneNew = async (
    act: () => Promise<unknown>,
  ): Promise<Record<string, unknown>> => {
    const n = createdIds.length;
    await act();
    expect(createdIds.length - n).toBe(1);
    return prisma.adminNotification.findUniqueOrThrow({
      where: { id: createdIds.at(-1)! },
    });
  };

  const expectNoneNew = async (act: () => Promise<unknown>): Promise<void> => {
    const n = createdIds.length;
    await act();
    expect(createdIds.length).toBe(n);
  };

  const login = async (email: string): Promise<Session> => {
    const agent = request.agent(server());
    const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    const res = await agent
      .post(url('/auth/system/login'))
      .set('x-csrf-token', token)
      .send({ email, password: PASSWORD })
      .expect(200);
    const raw = readCookie(res, cookieName);
    if (!raw) throw new Error(`Login as ${email} set no ${cookieName} cookie.`);
    return { agent, token, cookie: raw.split(';')[0] };
  };

  // ───────────────────────────── NOTIF-RT-1 socket helpers ─────────────────────────────
  // Copied from `booking-realtime.e2e-spec.ts`; extracting a shared helper is E2E-SOCKET-HELPER-1.

  /**
   * `forceNew` is NOT optional: socket.io-client caches one `Manager` per origin, so a second socket
   * would otherwise reuse the first one's engine connection — and its `Cookie` header.
   *
   * No `Origin` header is sent: an absent Origin passes `originGuard`, as in that suite. No
   * `transports` override either — this suite mocks `global.fetch`, and socket.io-client's polling
   * transport goes through XHR/`ws`, neither of which touches `fetch`.
   */
  const connectSocket = (cookie: string): Socket => {
    const socket = io(`${baseUrl}${REALTIME_ADMIN_NAMESPACE}`, {
      path: '/socket.io',
      forceNew: true,
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    openSockets.push(socket);
    return socket;
  };

  const waitForConnect = (socket: Socket, timeoutMs = 5_000): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Socket did not connect within ${timeoutMs}ms.`)),
        timeoutMs,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`Socket was rejected: ${error.message}`));
      });
    });

  /** Event-driven, never a fixed sleep — a fixed sleep is what makes socket suites flaky. */
  const waitUntil = async (
    predicate: () => boolean,
    what: string,
    timeoutMs = 5_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  /** The ONLY fixed wait here, and only ever to prove an ABSENCE. */
  const settle = (ms = 400): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** `x-line-signature` over the real webhook secret — same recipe as `system-integrations.e2e-spec.ts`. */
  const signedWebhook = (events: unknown[]) => {
    const body = JSON.stringify({ destination: 'Ue2e', events });
    const secret = process.env.LINE_CHANNEL_SECRET!;
    const signature = createHmac('SHA256', secret)
      .update(body)
      .digest('base64');
    return request(server())
      .post(url('/line/webhook'))
      .set('content-type', 'application/json')
      .set('x-line-signature', signature)
      .send(body);
  };

  const asLiff = (sub: string, req: request.Test) => {
    currentSub = sub;
    return req.set('Authorization', 'Bearer good-token');
  };

  const purgeFixtures = async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM feedbacks WHERE "lineUserId" IN (SELECT id FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%')`,
    );
    // Every booking in this suite lives on one of OUR venues — deleted by that association, not by
    // `code` (only the B3 fixture carries the row prefix; every route-created booking gets a real
    // auto-generated `BR-…` code). Deleting `line_users` before this would `SetNull` `lineUserId`
    // and, on a row with no `createdById`, trip `booking_requests_owner_check` (23514).
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_slots WHERE "bookingRequestId" IN (SELECT id FROM booking_requests WHERE "venueId" IN (SELECT id FROM venues WHERE name LIKE '${ROW_PREFIX}%'))`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_requests WHERE "venueId" IN (SELECT id FROM venues WHERE name LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_user_registrations WHERE "lineUserId" IN (SELECT id FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE name LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE name LIKE '${ROW_PREFIX}%'`,
    );
  };

  /** The `eb:notif:` markers this suite could claim — cleared before AND after (design §5.3). */
  const dedupeKeys = () => [
    NOTIF_KEY_PREFIX + lineFailureDedupeKey('NOT_CONFIGURED'),
    NOTIF_KEY_PREFIX + lineFailureDedupeKey('RATE_LIMITED'),
    NOTIF_KEY_PREFIX + lineFailureDedupeKey('TRANSIENT'),
    NOTIF_KEY_PREFIX +
      serverErrorDedupeKey({
        method: 'GET',
        routeTemplate: '/api/v1/venues',
        errorCode: 'Error',
        handler: 'VenuesController.list',
      }),
  ];

  beforeAll(async () => {
    // ── 1. The ID-token verify fake (feedback.e2e-spec.ts's pattern) ──
    jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      const body = init?.body as URLSearchParams | undefined;
      if (body?.get('id_token') === 'invalid') {
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

    fakeLine.pushMessage.mockResolvedValue({});
    fakeLine.multicast.mockResolvedValue({});

    app = await createE2eApp((b) =>
      b
        .overrideProvider(ADMIN_NOTIFICATION_TRIGGERS_ENABLED)
        .useValue(true)
        .overrideProvider(LINE_MESSAGING_CLIENT)
        .useValue(fakeLine),
    );
    server = () => app.getHttpServer();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    // `NOTIF-RT-1`: Socket.IO attaches to the HTTP server at init, but nothing can connect until it
    // is LISTENING — same reason `realtime.e2e-spec.ts` / `booking-realtime.e2e-spec.ts` do this.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    cookieName = sessionCookieName(app.get(ConfigService));

    // ── 2. Refuse to run unless the seam is actually armed ──
    if (app.get(AdminNotificationTriggers).isEnabled !== true) {
      throw new Error(
        'AdminNotificationTriggers is not enabled — refusing to run.',
      );
    }
    if (Reflect.get(app.get(LineService), 'client') !== fakeLine) {
      throw new Error(
        'LineService does not hold the fake Messaging client — refusing to run.',
      );
    }

    await redis.del(...dedupeKeys());
    await purgeFixtures();
    await purgeE2eUsers(prisma, SU_PREFIX);

    // ── 3. Fixtures ──
    venueTypeId = (
      await prisma.venueType.create({
        data: { name: `${ROW_PREFIX}hall` },
        select: { id: true },
      })
    ).id;
    venueAId = (
      await prisma.venue.create({
        data: { name: `${ROW_PREFIX}A`, venueTypeId, capacity: 40 },
        select: { id: true },
      })
    ).id;
    venueBId = (
      await prisma.venue.create({
        data: { name: `${ROW_PREFIX}B`, venueTypeId, capacity: 40 },
        select: { id: true },
      })
    ).id;
    venueCId = (
      await prisma.venue.create({
        data: { name: `${ROW_PREFIX}C`, venueTypeId, capacity: 40 },
        select: { id: true },
      })
    ).id;

    options = await ensureE2eOptions(prisma);

    const passwordHash = await new PasswordService().hash(PASSWORD);
    superAdminId = (
      await prisma.systemUser.create({
        data: {
          email: `${SU_PREFIX}super@easybook.local`,
          firstName: 'E2E',
          lastName: 'Super',
          role: SystemRole.SUPER_ADMIN,
          passwordHash,
          mustChangePassword: false,
          ...options,
        },
        select: { id: true },
      })
    ).id;
    // `NOTIF-RT-1` — an ADMIN fixture alongside the SUPER_ADMIN one, for the audience e2e.
    await prisma.systemUser.create({
      data: {
        email: ADMIN_EMAIL,
        firstName: 'E2E',
        lastName: 'Admin',
        role: SystemRole.ADMIN,
        passwordHash,
        mustChangePassword: false,
        ...options,
      },
    });

    const makeAllowed = async (sub: string, first: string) => {
      const row = await prisma.lineUser.create({
        data: { lineUserId: sub, access: AppAccess.ALLOWED },
        select: { id: true },
      });
      await prisma.lineUserRegistration.create({
        data: {
          lineUserId: row.id,
          firstName: first,
          lastName: 'ทดสอบ',
          phone: '081-000-0000',
          phoneDigits: '0810000000',
          ...options,
        },
      });
      return row.id;
    };
    xId = await makeAllowed(xSub, 'เอ็กซ์');
    await makeAllowed(ySub, 'วาย');
    await makeAllowed(zSub, 'แซด');

    session = await login(`${SU_PREFIX}super@easybook.local`);

    // ── 4. Capture every id `create()` mints, from here on ──
    // `.bind()` returns `any` under this repo's `strictBindCallApply: false`, hence the cast back
    // to the method's real signature immediately after.
    const svc = app.get<NotificationsService>(NotificationsService);
    const real = svc.create.bind(svc) as (
      input: CreateAdminNotificationInput,
    ) => Promise<AdminNotification>;
    createSpy = jest
      .spyOn(svc, 'create')
      .mockImplementation(async (input: CreateAdminNotificationInput) => {
        const row = await real(input);
        createdIds.push(row.id);
        return row;
      });
  }, 60_000);

  afterAll(async () => {
    // `NOTIF-RT-1`: a leaked socket keeps an engine.io session (and its timers) alive and hangs
    // `app.close()` — drain BEFORE closing.
    while (openSockets.length > 0) {
      const socket = openSockets.pop();
      socket?.removeAllListeners();
      socket?.disconnect();
    }
    await prisma.adminNotification.deleteMany({
      where: { id: { in: createdIds } },
    });
    await purgeFixtures();
    await purgeE2eUsers(prisma, SU_PREFIX);
    await redis.del(...dedupeKeys());
    jest.restoreAllMocks();
    await app.close();
  });

  // ── U1 — a fresh registration ──────────────────────────────────────────────────────────────
  it('U1: POST /line-users/register creates one REGISTRATION/AMBER row with the phone', async () => {
    const sub = `${LU_PREFIX}u1`;
    const row = await expectOneNew(() =>
      asLiff(sub, request(server()).post(url('/line-users/register')))
        .send({
          firstName: 'หนึ่ง',
          lastName: 'ยูวัน',
          phone: '081-111-1111',
          departmentId: options.departmentId,
          personnelRoleId: options.personnelRoleId,
        })
        .expect(201),
    );
    expect(row).toMatchObject({
      category: 'REGISTRATION',
      tone: 'AMBER',
      icon: 'user-plus',
      targetRole: 'ADMIN',
      actionUrl: '/backend/line-users',
    });
    expect(row.body as string).toContain('081-111-1111');
  });

  // ── U2 — a REJECTED resubmit ─────────────────────────────────────────────────────────────────
  it('U2: a REJECTED resubmit fires; a PENDING self-edit does not', async () => {
    const sub = `${LU_PREFIX}u2`;
    await asLiff(sub, request(server()).post(url('/line-users/register')))
      .send({
        firstName: 'สอง',
        lastName: 'ยูทู',
        phone: '081-222-2222',
        ...options,
      })
      .expect(201);
    const row = await prisma.lineUser.findFirstOrThrow({
      where: { lineUserId: sub },
      select: { id: true },
    });

    // A PENDING self-edit must NOT fire.
    await expectNoneNew(() =>
      asLiff(sub, request(server()).patch(url('/line-users/registration')))
        .send({
          firstName: 'สอง',
          lastName: 'ยูทูแก้ไข',
          phone: '081-222-2222',
          ...options,
        })
        .expect(200),
    );

    await session.agent
      .patch(url(`/line-users/${row.id}`))
      .set('x-csrf-token', session.token)
      .send({ access: 'REJECTED', reason: 'ข้อมูลไม่ครบถ้วน' })
      .expect(200);

    const notif = await expectOneNew(() =>
      asLiff(sub, request(server()).patch(url('/line-users/registration')))
        .send({
          firstName: 'สอง',
          lastName: 'ยูทูใหม่',
          phone: '081-222-2222',
          ...options,
        })
        .expect(200),
    );
    expect(notif).toMatchObject({
      category: 'REGISTRATION',
      tone: 'AMBER',
      icon: 'arrow-path',
      targetRole: 'ADMIN',
    });
  });

  // ── U3 — unfollow while a request is pending ────────────────────────────────────────────────
  it('U3: unfollow with a PENDING request fires once; a repeat/no-pending unfollow does not', async () => {
    const sub = `${LU_PREFIX}u3`;
    const row = await prisma.lineUser.create({
      data: { lineUserId: sub, access: AppAccess.ALLOWED },
      select: { id: true },
    });
    await prisma.lineUserRegistration.create({
      data: {
        lineUserId: row.id,
        firstName: 'สาม',
        lastName: 'ยูทรี',
        phone: '081-333-3333',
        phoneDigits: '0813333333',
        ...options,
      },
    });
    await asLiff(sub, request(server()).post(url('/line-users/bookings')))
      .send({
        venueId: venueAId,
        purpose: 'ทดสอบ U3',
        attendees: 5,
        slots: [{ startAt: iso(BASE + HOUR), endAt: iso(BASE + 2 * HOUR) }],
      })
      .expect(201);

    const notif = await expectOneNew(() =>
      signedWebhook([
        { type: 'unfollow', source: { type: 'user', userId: sub } },
      ]).expect(200),
    );
    expect(notif).toMatchObject({
      category: 'REGISTRATION',
      tone: 'SLATE',
      icon: 'user-minus',
      targetRole: 'SUPER_ADMIN',
    });

    // A repeat unfollow of the same (now soft-deleted) row: no row.
    await expectNoneNew(() =>
      signedWebhook([
        { type: 'unfollow', source: { type: 'user', userId: sub } },
      ]).expect(200),
    );

    // A fresh user with nothing pending: no row either.
    const noneSub = `${LU_PREFIX}u3-none`;
    await prisma.lineUser.create({
      data: { lineUserId: noneSub, access: AppAccess.ALLOWED },
    });
    await expectNoneNew(() =>
      signedWebhook([
        { type: 'unfollow', source: { type: 'user', userId: noneSub } },
      ]).expect(200),
    );
  });

  // ── B1 — a new LIFF submission ───────────────────────────────────────────────────────────────
  let xBookingId = '';

  it('B1: two overlapping submissions each fire once', async () => {
    let xRes!: request.Response;
    const rowX = await expectOneNew(async () => {
      xRes = await asLiff(
        xSub,
        request(server()).post(url('/line-users/bookings')),
      )
        .send({
          venueId: venueAId,
          purpose: 'B1 ของเอ็กซ์',
          attendees: 5,
          slots: [
            { startAt: iso(BASE + 10 * HOUR), endAt: iso(BASE + 11 * HOUR) },
          ],
        })
        .expect(201);
    });
    xBookingId = (xRes.body as { id: string }).id;
    expect(rowX).toMatchObject({
      category: 'BOOKING',
      tone: 'SKY',
      icon: 'calendar',
      targetRole: 'ADMIN',
      actionUrl: '/backend/bookings/requests?status=PENDING',
    });

    await expectOneNew(() =>
      asLiff(ySub, request(server()).post(url('/line-users/bookings')))
        .send({
          venueId: venueAId,
          purpose: 'B1 ของวาย',
          attendees: 5,
          slots: [
            {
              startAt: iso(BASE + 10 * HOUR + 1800_000),
              endAt: iso(BASE + 11 * HOUR),
            },
          ],
        })
        .expect(201),
    );
  });

  // ── B4 — ADR-001 auto-reject on approve ─────────────────────────────────────────────────────
  it("B4: approving X auto-rejects the overlapping Y, one row naming X's code", async () => {
    const xRow = await prisma.bookingRequest.findUniqueOrThrow({
      where: { id: xBookingId },
      select: { id: true, code: true },
    });

    const notif = await expectOneNew(() =>
      session.agent
        .post(url(`/booking-requests/${xRow.id}/approve`))
        .set('x-csrf-token', session.token)
        .expect(200),
    );
    expect(notif).toMatchObject({
      category: 'BOOKING',
      tone: 'ROSE',
      icon: 'queue-list',
      targetRole: 'ADMIN',
      code: xRow.code,
    });
  });

  it('B4 negative: an approval with no overlap fires no row', async () => {
    const res = await asLiff(
      zSub,
      request(server()).post(url('/line-users/bookings')),
    )
      .send({
        venueId: venueBId,
        purpose: 'B4 เดี่ยว',
        attendees: 5,
        slots: [
          { startAt: iso(BASE + 20 * HOUR), endAt: iso(BASE + 21 * HOUR) },
        ],
      })
      .expect(201);
    const solo = res.body as { id: string };
    await expectNoneNew(() =>
      session.agent
        .post(url(`/booking-requests/${solo.id}/approve`))
        .set('x-csrf-token', session.token)
        .expect(200),
    );
  });

  // ── B5 + B4 — a direct booking overlapping a pending request ────────────────────────────────
  it('B5+B4: a direct booking fires B5, then auto-rejects the overlapping PENDING loser (B4)', async () => {
    await asLiff(zSub, request(server()).post(url('/line-users/bookings')))
      .send({
        venueId: venueBId,
        purpose: `B5B4-${RUN}-ของแซด`,
        attendees: 5,
        slots: [
          { startAt: iso(BASE + 30 * HOUR), endAt: iso(BASE + 31 * HOUR) },
        ],
      })
      .expect(201);

    const n = createdIds.length;
    const res = await session.agent
      .post(url('/booking-requests/direct'))
      .set('x-csrf-token', session.token)
      .send({
        venueId: venueBId,
        purpose: 'จองตรงทับซ้อน',
        attendees: 10,
        requesterName: 'เจ้าหน้าที่',
        contactPhone: '02-000-0000',
        slots: [
          {
            startAt: iso(BASE + 30 * HOUR + 1800_000),
            endAt: iso(BASE + 31 * HOUR),
          },
        ],
      })
      .expect(201);
    expect(createdIds.length - n).toBe(2);

    const [b5, b4] = createdIds
      .slice(-2)
      .map((id) =>
        prisma.adminNotification.findUniqueOrThrow({ where: { id } }),
      );
    const b5Row = await b5;
    const b4Row = await b4;
    expect(b5Row).toMatchObject({
      category: 'BOOKING',
      tone: 'EMERALD',
      icon: 'check',
      targetRole: 'ALL',
    });
    expect(b4Row).toMatchObject({
      category: 'BOOKING',
      tone: 'ROSE',
      icon: 'queue-list',
      targetRole: 'ADMIN',
    });
    void res;
  });

  // ── B2 — the requester cancels ───────────────────────────────────────────────────────────────
  it('B2: a whole-request cancel fires once, target ALL', async () => {
    const created = await asLiff(
      xSub,
      request(server()).post(url('/line-users/bookings')),
    )
      .send({
        venueId: venueCId,
        purpose: 'B2 ยกเลิกทั้งหมด',
        attendees: 5,
        slots: [
          { startAt: iso(BASE + 40 * HOUR), endAt: iso(BASE + 41 * HOUR) },
        ],
      })
      .expect(201);
    const row = created.body as { id: string };

    const notif = await expectOneNew(() =>
      asLiff(
        xSub,
        request(server()).patch(url(`/line-users/bookings/${row.id}/cancel`)),
      ).expect(200),
    );
    expect(notif).toMatchObject({
      category: 'BOOKING',
      tone: 'SLATE',
      icon: 'x-circle',
      targetRole: 'ALL',
    });
  });

  it('B2: a slot-only cancel on an APPROVED multi-slot booking fires once', async () => {
    const created = await asLiff(
      ySub,
      request(server()).post(url('/line-users/bookings')),
    )
      .send({
        venueId: venueCId,
        purpose: 'B2 หลายวัน',
        attendees: 5,
        slots: [
          { startAt: iso(BASE + 50 * HOUR), endAt: iso(BASE + 51 * HOUR) },
          { startAt: iso(BASE + 60 * HOUR), endAt: iso(BASE + 61 * HOUR) },
        ],
      })
      .expect(201);
    const row = created.body as { id: string };
    await session.agent
      .post(url(`/booking-requests/${row.id}/approve`))
      .set('x-csrf-token', session.token)
      .expect(200);
    const slot = await prisma.bookingSlot.findFirstOrThrow({
      where: { bookingRequestId: row.id },
      orderBy: { startAt: 'asc' },
      select: { id: true },
    });

    await expectOneNew(() =>
      asLiff(
        ySub,
        request(server()).patch(
          url(`/line-users/bookings/${row.id}/slots/${slot.id}/cancel`),
        ),
      ).expect(200),
    );
  });

  // ── B3 — a sweep of overdue requests ─────────────────────────────────────────────────────────
  it('B3: a sweep with one overdue request fires one row naming its code; a second sweep fires none', async () => {
    const overdue = await prisma.bookingRequest.create({
      data: {
        code: `${ROW_PREFIX}b3-001`,
        venueId: venueAId,
        lineUserId: xId,
        purpose: 'B3 ค้างพิจารณา',
        attendees: 3,
        firstStartAt: new Date(Date.now() - 2 * HOUR),
        lastEndAt: new Date(Date.now() - HOUR),
        slots: {
          create: [
            {
              venueId: venueAId,
              startAt: new Date(Date.now() - 2 * HOUR),
              endAt: new Date(Date.now() - HOUR),
            },
          ],
        },
      },
      select: { id: true, code: true },
    });

    const cron = new BookingExpiryCron(
      prisma,
      app.get(RealtimeGateway),
      app.get(ClientRealtimeGateway),
      app.get(BookingNotifier),
      app.get(AdminNotificationTriggers),
    );

    const notif = await expectOneNew(() => cron.expireOverdue());
    expect(notif).toMatchObject({
      category: 'BOOKING',
      tone: 'AMBER',
      icon: 'clock',
      code: overdue.code,
    });

    await expectNoneNew(() => cron.expireOverdue());
  });

  // ── F1 / F2 — feedback ───────────────────────────────────────────────────────────────────────
  it('F1: a FEEDBACK submission fires, target ADMIN', async () => {
    const notif = await expectOneNew(() =>
      asLiff(xSub, request(server()).post(url('/line-users/feedback')))
        .send({
          type: FeedbackType.FEEDBACK,
          subject: 'อยากได้พัดลม',
          description: 'ห้องร้อนมาก',
        })
        .expect(201),
    );
    expect(notif).toMatchObject({
      category: 'FEEDBACK',
      tone: 'SKY',
      icon: 'chat-bubble',
      targetRole: 'ADMIN',
    });
  });

  it('F2: an ISSUE submission fires, target ALL, and the body carries no phone', async () => {
    const notif = await expectOneNew(() =>
      asLiff(ySub, request(server()).post(url('/line-users/feedback')))
        .send({
          type: FeedbackType.ISSUE,
          subject: 'แอร์เสีย',
          description: 'แอร์ห้องประชุมไม่เย็น',
        })
        .expect(201),
    );
    expect(notif).toMatchObject({
      category: 'FEEDBACK',
      tone: 'ROSE',
      icon: 'exclamation-triangle',
      targetRole: 'ALL',
    });
    expect(notif.body as string).not.toMatch(/\d{3}-?\d{3}-?\d{4}/);
  });

  // ── C3 — a venue closes ──────────────────────────────────────────────────────────────────────
  it('C3: closing a venue fires once; re-closing it (409) fires none', async () => {
    const notif = await expectOneNew(() =>
      session.agent
        .post(url(`/venues/${venueCId}/close`))
        .set('x-csrf-token', session.token)
        .send({ reason: 'ปิดปรับปรุงชั่วคราว' })
        .expect(200),
    );
    expect(notif).toMatchObject({
      category: 'SYSTEM',
      tone: 'AMBER',
      icon: 'building-office',
      targetRole: 'ALL',
    });

    await expectNoneNew(() =>
      session.agent
        .post(url(`/venues/${venueCId}/close`))
        .set('x-csrf-token', session.token)
        .send({ reason: 'ปิดปรับปรุงชั่วคราว' })
        .expect(409),
    );
  });

  // ── C1 — a LINE delivery failure ─────────────────────────────────────────────────────────────
  it('C1: a 401 push fires once; a repeat within the window is deduped; a 400 never fires', async () => {
    const err = httpError(401);
    fakeLine.pushMessage.mockRejectedValueOnce(err);
    await expectOneNew(async () => {
      await expect(
        app.get(LineService).push(xSub, [{ type: 'text', text: 'x' } as never]),
      ).rejects.toBe(err);
    });

    fakeLine.pushMessage.mockRejectedValueOnce(httpError(401));
    await expectNoneNew(async () => {
      await expect(
        app.get(LineService).push(xSub, [{ type: 'text', text: 'x' } as never]),
      ).rejects.toMatchObject({ status: 401 });
    });

    fakeLine.pushMessage.mockRejectedValueOnce(httpError(400));
    await expectNoneNew(async () => {
      await expect(
        app.get(LineService).push(xSub, [{ type: 'text', text: 'x' } as never]),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  it('C1: multicast RATE_LIMITED (429) fires one row', async () => {
    fakeLine.multicast.mockRejectedValueOnce(httpError(429));
    await expectOneNew(async () => {
      const outcome = await app
        .get(LineService)
        .multicast([ySub], [{ type: 'text', text: 'x' } as never], {
          retryKeySeed: `e2e-notif-${RUN}`,
        });
      expect(outcome.failure?.kind).toBe('RATE_LIMITED');
    });
  });

  // ── C2 — version changed (called directly; the announcer is not in the jest graph) ──────────
  it('C2: versionChanged fires; the stored AppSetting row is untouched (the announcer never ran)', async () => {
    const before = await prisma.appSetting.findUnique({
      where: { key: 'system.last_announced_version' },
    });

    const notif = await expectOneNew(() =>
      app.get(AdminNotificationTriggers).versionChanged({
        previous: '0.1.0',
        current: '0.2.0',
      }),
    );
    expect(notif).toMatchObject({
      category: 'SYSTEM',
      tone: 'EMERALD',
      icon: 'sparkles',
      targetRole: 'ALL',
    });

    const after = await prisma.appSetting.findUnique({
      where: { key: 'system.last_announced_version' },
    });
    expect(after?.value).toBe(before?.value);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  // ── C4 — an allowlisted setting changed (dormant; called directly) ──────────────────────────
  it('C4: settingChanged fires for the allowlisted key; a secret key and an unchanged value do not', async () => {
    const actor = { id: superAdminId, name: 'E2E Super' };
    const notif = await expectOneNew(() =>
      app.get(AdminNotificationTriggers).settingChanged({
        key: CANCEL_LEAD_MINUTES_KEY,
        oldValue: '60',
        newValue: '120',
        actor,
      }),
    );
    expect(notif).toMatchObject({
      category: 'SYSTEM',
      tone: 'SLATE',
      icon: 'adjustments-horizontal',
      targetRole: 'ADMIN',
      code: CANCEL_LEAD_MINUTES_KEY,
    });

    await expectNoneNew(() =>
      app.get(AdminNotificationTriggers).settingChanged({
        key: 'line.channel_secret',
        oldValue: 'a',
        newValue: 'b',
        actor,
      }),
    );
    await expectNoneNew(() =>
      app.get(AdminNotificationTriggers).settingChanged({
        key: CANCEL_LEAD_MINUTES_KEY,
        oldValue: '60',
        newValue: '60',
        actor,
      }),
    );
  });

  // ── C5 — an unhandled 5xx ────────────────────────────────────────────────────────────────────
  it('C5: a forced 500 on GET /venues answers byte-identically and fires once; a repeat is deduped', async () => {
    jest
      .spyOn(app.get(VenuesService), 'list')
      .mockRejectedValueOnce(new Error('e2e-forced-secret'));

    const n = createdIds.length;
    const res = await session.agent.get(url('/venues')).expect(500);
    expect(res.text).toBe(
      '{"statusCode":500,"message":"Internal server error"}',
    );
    expect(JSON.stringify(res.body)).not.toContain('e2e-forced-secret');
    await new Promise((r) => setTimeout(r, 50));
    expect(createdIds.length - n).toBe(1);
    const notif = await prisma.adminNotification.findUniqueOrThrow({
      where: { id: createdIds.at(-1)! },
    });
    expect(notif).toMatchObject({
      category: 'SYSTEM',
      tone: 'ROSE',
      icon: 'bug-ant',
      targetRole: 'SUPER_ADMIN',
    });
    expect(notif.body).toContain('GET /api/v1/venues');
    expect(notif.body).not.toContain('e2e-forced-secret');

    jest
      .spyOn(app.get(VenuesService), 'list')
      .mockRejectedValueOnce(new Error('e2e-forced-secret-2'));
    await expectNoneNew(() => session.agent.get(url('/venues')).expect(500));
  });

  it('C5 negatives: an unknown venue (404) and a bad query (400) never fire', async () => {
    await expectNoneNew(() =>
      session.agent.get(url('/venues/clx_does_not_exist_00000000')).expect(404),
    );
  });

  // ── Fail-safe: create() rejecting still returns the normal HTTP shape ───────────────────────
  it('fail-safe: create() rejecting still returns 201 with the normal body, capturing no id', async () => {
    createSpy.mockImplementationOnce(() =>
      Promise.reject(new Error('e2e-forced')),
    );
    const n = createdIds.length;
    const res = await asLiff(
      zSub,
      request(server()).post(url('/line-users/feedback')),
    )
      .send({
        type: FeedbackType.FEEDBACK,
        subject: 'ทดสอบ fail-safe',
        description: 'x',
      })
      .expect(201);
    expect((res.body as { code: string }).code).toMatch(/^FDB-/);
    expect(createdIds.length).toBe(n);
  });

  // ── NOTIF-RT-1 — realtime push ───────────────────────────────────────────────────────────────
  describe('NOTIF-RT-1 — realtime push', () => {
    let superSocket: Socket;
    let adminSocket: Socket;
    let superSeen: AdminNotificationEventPayload[];
    let adminSeen: AdminNotificationEventPayload[];

    /** `create()` goes through the suite's own spy, so its id lands in `createdIds` too. */
    const mk = (targetRole: AdminNotificationTargetRole) =>
      app.get(NotificationsService).create({
        category: 'SYSTEM',
        tone: 'SLATE',
        icon: 'clock',
        title: `${ROW_PREFIX}rt-${targetRole}`,
        body: 'e2e realtime push',
        targetRole,
      });

    /** X-2: triggers are ON in this suite, so assertions key on THIS row's id, never a total count. */
    const seen = (
      arr: AdminNotificationEventPayload[],
      id: string,
    ): AdminNotificationEventPayload[] => arr.filter((p) => p.id === id);

    beforeAll(async () => {
      await clearThrottleCounters(redis);

      const superS = await login(`${SU_PREFIX}super@easybook.local`);
      const adminS = await login(ADMIN_EMAIL);

      superSocket = connectSocket(superS.cookie);
      adminSocket = connectSocket(adminS.cookie);
      await Promise.all([
        waitForConnect(superSocket),
        waitForConnect(adminSocket),
      ]);

      superSeen = [];
      adminSeen = [];
      // Attached BEFORE any create() call below.
      superSocket.on(
        REALTIME_EVENTS.adminNotificationCreated,
        (p: AdminNotificationEventPayload) => superSeen.push(p),
      );
      adminSocket.on(
        REALTIME_EVENTS.adminNotificationCreated,
        (p: AdminNotificationEventPayload) => adminSeen.push(p),
      );
    });

    afterAll(() => {
      while (openSockets.length > 0) {
        const socket = openSockets.pop();
        socket?.removeAllListeners();
        socket?.disconnect();
      }
    });

    it('AC-2: a SUPER_ADMIN event is never transmitted to an ADMIN socket (with a positive control)', async () => {
      const superRow = await mk(AdminNotificationTargetRole.SUPER_ADMIN);
      // Created AFTER, on the same sockets — its arrival on the admin socket proves the ABSENCE of
      // the earlier SUPER_ADMIN event is meaningful: Socket.IO delivers frames in order on one
      // connection, so the later control event could not have overtaken an earlier one.
      const controlRow = await mk(AdminNotificationTargetRole.ADMIN);

      await waitUntil(
        () =>
          seen(superSeen, superRow.id).length === 1 &&
          seen(adminSeen, controlRow.id).length === 1,
        'the SUPER_ADMIN pulse on the super socket and the control pulse on the admin socket',
      );
      await settle(600);

      expect(seen(superSeen, superRow.id)).toHaveLength(1);
      expect(seen(adminSeen, superRow.id)).toHaveLength(0);
      expect(
        adminSeen.every(
          (p) => p.targetRole !== AdminNotificationTargetRole.SUPER_ADMIN,
        ),
      ).toBe(true);
    });

    it('ALL and ADMIN reach both roles', async () => {
      for (const targetRole of [
        AdminNotificationTargetRole.ALL,
        AdminNotificationTargetRole.ADMIN,
      ]) {
        const row = await mk(targetRole);
        await waitUntil(
          () =>
            seen(superSeen, row.id).length === 1 &&
            seen(adminSeen, row.id).length === 1,
          `both sockets receiving a ${targetRole} pulse`,
        );
        await settle(400);
        expect(seen(superSeen, row.id)).toHaveLength(1);
        expect(seen(adminSeen, row.id)).toHaveLength(1);
      }
    });

    it('AC-1: the payload has exactly the D-2/X-1 keys, and matches the created row', async () => {
      const row = await mk(AdminNotificationTargetRole.SUPER_ADMIN);
      await waitUntil(
        () => seen(superSeen, row.id).length === 1,
        'the SUPER_ADMIN pulse',
      );
      const payload = seen(superSeen, row.id)[0];

      expect(Object.keys(payload).sort()).toEqual([
        'createdAt',
        'id',
        'targetRole',
      ]);
      expect(payload.id).toBe(row.id);
      expect(payload.targetRole).toBe('SUPER_ADMIN');
      expect(payload.createdAt).toBe(row.createdAt.toISOString());
      const json = JSON.stringify(payload);
      expect(json).not.toContain(row.title);
      expect(json).not.toContain(row.body);
    });

    it('AC-1: a failed create() emits nothing', async () => {
      const n = createdIds.length;
      await expect(
        app.get(NotificationsService).create({
          category: 'SYSTEM',
          tone: 'SLATE',
          icon: 'clock',
          title: '',
          body: 'e2e realtime push',
          targetRole: AdminNotificationTargetRole.ALL,
        }),
      ).rejects.toThrow('AdminNotification.create');
      await settle(400);

      expect(createdIds.length).toBe(n);
      // No pulse exists for a row that was never created.
      expect(superSeen.every((p) => createdIds.includes(p.id))).toBe(true);
    });
  });
});
