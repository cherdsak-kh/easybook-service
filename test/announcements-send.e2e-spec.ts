import { randomBytes } from 'node:crypto';
import { HTTPFetchError, messagingApi } from '@line/bot-sdk';
import { Logger, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  AnnouncementAudience,
  AnnouncementFormat,
  AnnouncementStatus,
  AppAccess,
  Prisma,
  SystemRole,
} from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ANNOUNCEMENT_SENT_IMMUTABLE } from '../src/announcements/announcements.constants';
import { ANNOUNCEMENT_ERROR_CODES } from '../src/announcements/dto/announcement-error.dto';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { INVALID_CSRF_TOKEN } from '../src/csrf/csrf.service';
import { LINE_MESSAGING_CLIENT } from '../src/line/line-messaging-client';
import { LineService } from '../src/line/line.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  clearThrottleCounters,
  createE2eApp,
  ensureE2eOptions,
  prismaOf,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(180_000);

/**
 * `ANNOUNCE-API-2` — `POST /announcements/:id/send` and `GET /announcements/line-bot-info` (plan
 * AC-4…AC-15, design §5.2). `ANNOUNCE-API-5` adds: the zero-recipient 200 (its AC-7, rewriting E-6),
 * DELETE vs a send holding the lock (its AC-4), a soft-deleted row's send → 404 (its AC-3), the
 * soft-deleted-department ordering (its AC-9) and the 10-value error enum (its AC-10).
 *
 * 🔴 NOTHING HERE MAY REACH LINE. `.env` holds a REAL channel token and the dev database holds REAL
 * `ALLOWED` LINE users. Three layers make a real send impossible, and the suite proves each one:
 *
 *   1. The Messaging client is REPLACED at the module boundary (`LINE_MESSAGING_CLIENT` → `fakeLine`,
 *      which has only `multicast` and `getBotInfo`). `beforeAll` REFUSES TO RUN unless the
 *      `LineService` the app resolved actually holds the fake.
 *   2. A `fetch` TRIPWIRE, installed before the app boots, rejects every request to `*.line.me` and
 *      records its path. `beforeAll` proves the tripwire intercepts the SDK by pointing a throwaway
 *      client (bogus token) at it, and the last test asserts it recorded nothing else.
 *   3. `AC-11` (≥ 501 recipients) is unit-only — this file never creates hundreds of users.
 *
 * 🔴 THE DATABASE IS SHARED. Every row is created here and deleted BY ID in `afterAll`. The crash-
 * recovery sweep is scoped to this file's `e2e-annsend-` prefix AND (for LINE users) the `Ue2e5e4d0`
 * id marker — both conditions, so a real user can never match. Recipient assertions on audience ALL
 * check CONTAINMENT, never totals, because real users exist.
 */

const PREFIX = 'e2e-annsend-';
/** Every fixture `lineUserId` starts with this: `U` + 8 hex marker, then 24 random hex (well-formed, S-5). */
const LINE_ID_MARK = 'Ue2e5e4d0';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;

const TRIPWIRE = 'E2E: real LINE API reached';
const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Unique per run, so the log assertion can look for the exact strings. */
const RUN = randomBytes(4).toString('hex');
const T = (name: string) => `${PREFIX}${name} ${RUN}`;
const B = (name: string) => `zqannsendbody ${name} ${RUN}`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

/** The Messaging client `LineService` actually holds (a private field) — read for the safety check only. */
const clientHeldBy = (service: LineService): unknown =>
  Reflect.get(service, 'client');

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
}
interface CodedError {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  acceptedCount?: number;
  targetedCount?: number;
}
interface AnnouncementBody {
  id: string;
  status: AnnouncementStatus;
  sentAt: string | null;
  sentCount: number;
}
type MulticastCall = [
  { to: string[]; messages: messagingApi.Message[] },
  string,
];

describe('Announcements — LINE send + bot info (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  /** 🔴 The ONLY Messaging client this app has. Nothing else — any other SDK method is undefined. */
  const fakeLine = { multicast: jest.fn(), getBotInfo: jest.fn() };

  /** Paths of every request that tried to reach `*.line.me`. Must end the suite empty. */
  const lineHits: string[] = [];
  let fetchSpy: jest.SpyInstance;
  let tripwireProof = '';

  let logSpies: jest.SpyInstance[] = [];

  let staffIds: Record<string, string> = {};
  let sessions: Record<string, Session> = {};
  const as = (email: string) => sessions[email];

  const announcementIds: string[] = [];
  const lineUserRowIds: string[] = [];
  const deptIds: number[] = [];
  const dept = { A: 0, B: 0, empty: 0, gone: 0 };
  /** Fixture key → its LINE `U…` id. */
  const fx: Record<string, string> = {};

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

  const sendAs = (email: string, id: string) =>
    as(email)
      .agent.post(url(`/announcements/${id}/send`))
      .set('x-csrf-token', as(email).token);

  /** ANNOUNCE-API-5 — the soft DELETE, through the API. */
  const deleteAs = (email: string, id: string) =>
    as(email)
      .agent.delete(url(`/announcements/${id}`))
      .set('x-csrf-token', as(email).token);

  const botInfoAs = (email: string) =>
    as(email).agent.get(url('/announcements/line-bot-info'));

  const seedAnnouncement = async (data: {
    title: string;
    body?: string;
    format?: AnnouncementFormat;
    audience?: AnnouncementAudience;
    departmentId?: number | null;
    status?: AnnouncementStatus;
  }): Promise<string> => {
    const sent = data.status === AnnouncementStatus.SENT;
    const { id } = await prisma.announcement.create({
      data: {
        title: data.title,
        body: data.body ?? B(data.title),
        format: data.format ?? AnnouncementFormat.TEXT,
        audience: data.audience ?? AnnouncementAudience.ALL,
        departmentId: data.departmentId ?? null,
        status: data.status ?? AnnouncementStatus.DRAFT,
        createdById: staffIds[ADMIN],
        ...(sent ? { sentAt: new Date(), sentCount: 7 } : {}),
      },
      select: { id: true },
    });
    announcementIds.push(id);
    return id;
  };

  const rawRow = (id: string) =>
    prisma.announcement.findUniqueOrThrow({ where: { id } });

  const makeDept = async (
    suffix: string,
    extra: { deletedAt?: Date } = {},
  ): Promise<number> => {
    const { id } = await prisma.department.create({
      data: { name: `${PREFIX}${suffix}`, ...extra },
      select: { id: true },
    });
    deptIds.push(id);
    return id;
  };

  const makeLineUser = async (
    key: string,
    o: {
      access: AppAccess;
      departmentId: number;
      personnelRoleId: number;
      deletedAt?: Date;
      registrationDeletedAt?: Date;
      notifications?: Prisma.InputJsonValue;
    },
  ): Promise<void> => {
    const row = await prisma.lineUser.create({
      data: {
        lineUserId: `${LINE_ID_MARK}${randomBytes(12).toString('hex')}`,
        displayName: `${PREFIX}${key}`,
        access: o.access,
        deletedAt: o.deletedAt ?? null,
        registration: {
          create: {
            firstName: 'E2E',
            lastName: key,
            phone: '081-234-5678',
            phoneDigits: '0812345678',
            departmentId: o.departmentId,
            personnelRoleId: o.personnelRoleId,
            deletedAt: o.registrationDeletedAt ?? null,
          },
        },
        ...(o.notifications
          ? { settings: { create: { notifications: o.notifications } } }
          : {}),
      },
      select: { id: true, lineUserId: true },
    });
    lineUserRowIds.push(row.id);
    fx[key] = row.lineUserId;
  };

  const calls = () => fakeLine.multicast.mock.calls as MulticastCall[];
  const sentTo = () => calls().flatMap(([req]) => req.to);

  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  const sweep = async () => {
    // Crash recovery ONLY — every condition is scoped to this file's prefix/marker.
    await prisma.announcement.deleteMany({
      where: { title: { startsWith: PREFIX } },
    });
    await prisma.lineUser.deleteMany({
      where: {
        lineUserId: { startsWith: LINE_ID_MARK },
        displayName: { startsWith: PREFIX },
      },
    });
    await prisma.department.deleteMany({
      where: { name: { startsWith: PREFIX } },
    });
    await purgeE2eUsers(prisma, PREFIX);
  };

  beforeAll(async () => {
    // ── 1. The tripwire, BEFORE anything can build a client ──
    const realFetch = globalThis.fetch;
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const href =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const u = new URL(href);
        if (/(^|\.)line\.me$/.test(u.hostname)) {
          lineHits.push(u.pathname); // the path only — never the query or body
          return Promise.reject(new Error(TRIPWIRE));
        }
        return realFetch(input, init);
      });

    // Prove the tripwire intercepts what the SDK actually calls (a bogus token; it cannot leave).
    tripwireProof = await new messagingApi.MessagingApiClient({
      channelAccessToken: 'e2e-bogus-token',
    })
      .getBotInfo()
      .then(
        () => 'resolved',
        (e: Error) => `${e.message} @ ${lineHits.join(',')}`,
      );
    if (tripwireProof !== `${TRIPWIRE} @ /v2/bot/info`) {
      throw new Error(
        `The fetch tripwire does not intercept the LINE SDK (${tripwireProof}) — refusing to run.`,
      );
    }
    lineHits.length = 0;

    logSpies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level),
    );

    // ── 2. Boot with the fake client ──
    app = await createE2eApp((b) =>
      b.overrideProvider(LINE_MESSAGING_CLIENT).useValue(fakeLine),
    );
    const wired = clientHeldBy(app.get(LineService));
    if (wired !== fakeLine) {
      throw new Error(
        'LineService does not hold the fake Messaging client — refusing to run.',
      );
    }

    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
    await sweep();

    // ── 3. Fixtures ──
    const options = await ensureE2eOptions(prisma);
    dept.A = await makeDept('A');
    dept.B = await makeDept('B');
    dept.empty = await makeDept('empty');
    dept.gone = await makeDept('gone', { deletedAt: new Date() });

    const { personnelRoleId } = options;
    const inA = { departmentId: dept.A, personnelRoleId };
    await makeLineUser('inA', { access: AppAccess.ALLOWED, ...inA });
    await makeLineUser('optedOut', {
      access: AppAccess.ALLOWED,
      ...inA,
      notifications: { announcements: false, decisions: true, reminders: true },
    });
    await makeLineUser('decisionsOff', {
      access: AppAccess.ALLOWED,
      ...inA,
      notifications: { announcements: true, decisions: false, reminders: true },
    });
    await makeLineUser('pending', { access: AppAccess.PENDING, ...inA });
    await makeLineUser('blocked', { access: AppAccess.BLOCKED, ...inA });
    await makeLineUser('deleted', {
      access: AppAccess.ALLOWED,
      ...inA,
      deletedAt: new Date(),
    });
    await makeLineUser('inB', {
      access: AppAccess.ALLOWED,
      departmentId: dept.B,
      personnelRoleId,
    });
    await makeLineUser('regGone', {
      access: AppAccess.ALLOWED,
      ...inA,
      registrationDeletedAt: new Date(),
    });
    await makeLineUser('emptyPending', {
      access: AppAccess.PENDING,
      departmentId: dept.empty,
      personnelRoleId,
    });
    await makeLineUser('emptyBlocked', {
      access: AppAccess.BLOCKED,
      departmentId: dept.empty,
      personnelRoleId,
    });

    // Staff belong to the SHARED e2e option department, never to one of ours.
    const passwordHash = await new PasswordService().hash(PASSWORD);
    staffIds = {};
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
    ] as Array<[string, SystemRole]>) {
      const row = await prisma.systemUser.create({
        data: {
          email,
          firstName: 'E2E',
          lastName: role,
          role,
          passwordHash,
          mustChangePassword: false,
          ...options,
        },
        select: { id: true },
      });
      staffIds[email] = row.id;
    }
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER]) {
      sessions[email] = await login(email);
    }
  }, 120_000);

  beforeEach(() => {
    fakeLine.multicast.mockReset().mockResolvedValue({});
    fakeLine.getBotInfo.mockReset();
  });

  afterAll(async () => {
    try {
      if (prisma) {
        // Announcements → LINE users (registration + settings cascade) → departments → staff.
        if (announcementIds.length > 0) {
          await prisma.announcement.deleteMany({
            where: { id: { in: announcementIds } },
          });
        }
        if (lineUserRowIds.length > 0) {
          await prisma.lineUser.deleteMany({
            where: { id: { in: lineUserRowIds } },
          });
        }
        if (deptIds.length > 0) {
          await prisma.department.deleteMany({
            where: { id: { in: deptIds } },
          });
        }
        await purgeE2eUsers(prisma, PREFIX);
      }
      if (redis) await clearThrottleCounters(redis);
    } finally {
      logSpies.forEach((s) => s.mockRestore());
      fetchSpy?.mockRestore();
      if (app) await app.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-0 — the safety wiring (D-L)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('E-0 — no real LINE client exists in this app', () => {
    it('the one Messaging client is the fake, and LineService holds it', () => {
      expect(app.get(LINE_MESSAGING_CLIENT, { strict: false })).toBe(fakeLine);
      expect(clientHeldBy(app.get(LineService))).toBe(fakeLine);
    });

    it('the fetch tripwire intercepted a real SDK call before the app booted', () => {
      expect(tripwireProof).toBe(`${TRIPWIRE} @ /v2/bot/info`);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-1…E-3 — GET /announcements/line-bot-info (AC-4, D-H)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-4 — GET /announcements/line-bot-info', () => {
    it('E-1 200 for all three roles with EXACTLY the four fields — it reaches bot info, not :id', async () => {
      fakeLine.getBotInfo.mockResolvedValue({
        userId: 'U-the-bot',
        basicId: '@e2e',
        premiumId: 'premium',
        displayName: 'EB',
        chatMode: 'chat',
        markAsReadMode: 'auto',
      });
      for (const email of [SUPER, ADMIN, VIEWER]) {
        const res = await botInfoAs(email).expect(200);
        expect(res.body).toEqual({
          basicId: '@e2e',
          displayName: 'EB',
          pictureUrl: null,
          chatMode: 'chat',
        });
      }
      expect(fakeLine.getBotInfo).toHaveBeenCalledTimes(3); // no cache (D-I)
    });

    it.each<[string, string, () => Error]>([
      ['HTTP 401', 'LINE_NOT_CONFIGURED', () => httpError(401)],
      ['HTTP 403', 'LINE_NOT_CONFIGURED', () => httpError(403)],
      [
        'a network error',
        'LINE_BOT_INFO_UNAVAILABLE',
        () => new TypeError('fetch failed'),
      ],
      ['HTTP 500', 'LINE_BOT_INFO_UNAVAILABLE', () => httpError(500)],
      ['HTTP 429', 'LINE_BOT_INFO_UNAVAILABLE', () => httpError(429)],
    ])('E-2 %s → 503 with code %s, never a 500', async (_label, code, err) => {
      fakeLine.getBotInfo.mockRejectedValue(err());
      const res = await botInfoAs(ADMIN).expect(503);
      const body = res.body as CodedError;
      expect(body.code).toBe(code);
      expect(body.statusCode).toBe(503);
      expect(JSON.stringify(body)).not.toContain('from LINE');
    });

    it('E-3 no session → 401, LINE never asked', async () => {
      await request(server())
        .get(url('/announcements/line-bot-info'))
        .expect(401);
      expect(fakeLine.getBotInfo).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-4 / E-5 — successful sends (AC-5, AC-6)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-5 / AC-6 — a successful send', () => {
    it('E-4 ADMIN sends a TEXT DEPARTMENT(A) draft → 200 SENT, exactly the eligible fixtures, in LineUser.id order', async () => {
      const title = T('e4 text dept');
      const body = B('e4');
      const created = await as(ADMIN)
        .agent.post(url('/announcements'))
        .set('x-csrf-token', as(ADMIN).token)
        .send({
          title,
          body,
          format: 'TEXT',
          audience: 'DEPARTMENT',
          departmentId: dept.A,
        });
      if (created.status === 201) {
        announcementIds.push((created.body as AnnouncementBody).id);
      }
      expect(created.status).toBe(201);
      const id = (created.body as AnnouncementBody).id;

      const res = await sendAs(ADMIN, id).expect(200);
      const dto = res.body as AnnouncementBody;

      // Department A is this file's own: the recipient set is fully controlled, so it is EXACT.
      const expectedOrder = (
        await prisma.lineUser.findMany({
          where: { lineUserId: { in: [fx.inA, fx.decisionsOff] } },
          orderBy: { id: 'asc' },
          select: { lineUserId: true },
        })
      ).map((u) => u.lineUserId);
      expect(sentTo()).toEqual(expectedOrder);
      for (const excluded of [
        'optedOut',
        'pending',
        'blocked',
        'deleted',
        'inB',
        'regGone',
      ]) {
        expect(sentTo()).not.toContain(fx[excluded]);
      }

      expect(calls()).toHaveLength(1);
      const [req, key] = calls()[0];
      expect(req.messages).toEqual([
        { type: 'text', text: `${title}\n\n${body}` },
      ]);
      expect(key).toMatch(UUID_V5);

      expect(dto.status).toBe(AnnouncementStatus.SENT);
      expect(dto.sentCount).toBe(2);
      expect(dto.sentAt).not.toBeNull();
      const row = await rawRow(id);
      expect(row.status).toBe(AnnouncementStatus.SENT);
      expect(row.sentCount).toBe(2);
      expect(row.sentAt?.toISOString()).toBe(dto.sentAt);
    });

    it('E-5 SUPER_ADMIN sends a FLEX draft to ALL → 200; the eligible fixtures are in `to`, the others are not', async () => {
      const id = await seedAnnouncement({
        title: T('e5 flex all'),
        format: AnnouncementFormat.FLEX,
      });

      const res = await sendAs(SUPER, id).expect(200);
      const dto = res.body as AnnouncementBody;

      const to = sentTo();
      // Real users exist in the dev DB: CONTAINMENT, never a total.
      expect(to).toEqual(
        expect.arrayContaining([fx.inA, fx.decisionsOff, fx.inB, fx.regGone]),
      );
      for (const excluded of [
        'optedOut',
        'pending',
        'blocked',
        'deleted',
        'emptyPending',
        'emptyBlocked',
      ]) {
        expect(to).not.toContain(fx[excluded]);
      }
      expect(new Set(to).size).toBe(to.length);
      for (const u of to) expect(u).toMatch(/^U[0-9a-f]{32}$/); // S-5
      for (const [req, key] of calls()) {
        expect(req.to.length).toBeLessThanOrEqual(500);
        expect(key).toMatch(UUID_V5);
      }

      const [req] = calls()[0];
      expect(req.messages).toHaveLength(1);
      const flex = req.messages[0] as messagingApi.FlexMessage;
      expect(flex.type).toBe('flex');
      expect(flex.altText).toBe(`ประกาศ: ${T('e5 flex all')}`);
      const bubble = flex.contents as messagingApi.FlexBubble;
      expect((bubble.header?.contents?.[0] as messagingApi.FlexText).text).toBe(
        'ประกาศจาก EasyBook',
      );
      expect(JSON.stringify(flex)).not.toContain('"action"');

      expect(dto.status).toBe(AnnouncementStatus.SENT);
      expect(dto.sentCount).toBe(to.length);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-6 / E-7 — refusals before LINE (AC-7, AC-8)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  // ANNOUNCE-API-5 D-2 reverses phase-2 AC-7: an empty audience is a COMPLETED send, not a 400.
  describe('ANNOUNCE-API-5 AC-7 — zero eligible recipients: 200 SENT, sentCount 0, no LINE call', () => {
    it('E-6 DEPARTMENT(empty) — only PENDING/BLOCKED users → 200 SENT / sentCount 0 / sentAt; the DB agrees; multicast never called; a resend → 409 ALREADY_SENT', async () => {
      const id = await seedAnnouncement({
        title: T('e6 empty'),
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: dept.empty,
      });
      const before = await rawRow(id);
      const startedAt = Date.now();

      const res = await sendAs(ADMIN, id).expect(200);
      const dto = res.body as AnnouncementBody;
      expect(dto.status).toBe(AnnouncementStatus.SENT);
      expect(dto.sentCount).toBe(0);
      expect(dto.sentAt).not.toBeNull();
      expect(new Date(dto.sentAt!).getTime()).toBeGreaterThanOrEqual(
        startedAt - 1_000,
      );
      expect(fakeLine.multicast).not.toHaveBeenCalled();

      const row = await rawRow(id);
      expect(row.status).toBe(AnnouncementStatus.SENT);
      expect(row.sentCount).toBe(0);
      expect(row.sentAt?.toISOString()).toBe(dto.sentAt);
      expect(row.deletedAt).toBeNull();
      expect(row.title).toBe(before.title);
      expect(row.body).toBe(before.body);

      const again = await sendAs(ADMIN, id).expect(409);
      expect((again.body as CodedError).code).toBe('ANNOUNCEMENT_ALREADY_SENT');
      expect(fakeLine.multicast).not.toHaveBeenCalled();
    });
  });

  describe('AC-7 / AC-8 — refused before LINE, row untouched', () => {
    const expectUnchangedAndSilent = async (
      id: string,
      before: Awaited<ReturnType<typeof rawRow>>,
    ) => {
      expect(fakeLine.multicast).not.toHaveBeenCalled();
      expect(await rawRow(id)).toEqual(before);
    };

    it('ANNOUNCE-API-5 AC-3 — a draft soft-deleted through the API → send is a coded 404, nothing sent, row untouched', async () => {
      const id = await seedAnnouncement({
        title: T('ac3 soft deleted'),
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: dept.A, // a sendable audience: only the delete stops it
      });
      await deleteAs(ADMIN, id).expect(204);
      const before = await rawRow(id);
      expect(before.deletedAt).not.toBeNull();

      const res = await sendAs(ADMIN, id).expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'Announcement not found.',
        code: 'ANNOUNCEMENT_NOT_FOUND',
      });
      await expectUnchangedAndSilent(id, before);
    });

    it('E-7 unknown id → 404 ANNOUNCEMENT_NOT_FOUND', async () => {
      const res = await sendAs(ADMIN, 'clx0000000000000000000000').expect(404);
      expect((res.body as CodedError).code).toBe('ANNOUNCEMENT_NOT_FOUND');
      expect(fakeLine.multicast).not.toHaveBeenCalled();
    });

    it('E-7 a SENT row → 409 ANNOUNCEMENT_ALREADY_SENT', async () => {
      const id = await seedAnnouncement({
        title: T('e7 sent'),
        status: AnnouncementStatus.SENT,
      });
      const before = await rawRow(id);
      const res = await sendAs(ADMIN, id).expect(409);
      expect((res.body as CodedError).code).toBe('ANNOUNCEMENT_ALREADY_SENT');
      await expectUnchangedAndSilent(id, before);
    });

    it.each(['', '  \n\t '])(
      'E-7 blank body %j → 400 ANNOUNCEMENT_BODY_REQUIRED',
      async (body) => {
        const id = await seedAnnouncement({ title: T('e7 blank'), body });
        const before = await rawRow(id);
        const res = await sendAs(ADMIN, id).expect(400);
        expect((res.body as CodedError).code).toBe(
          'ANNOUNCEMENT_BODY_REQUIRED',
        );
        await expectUnchangedAndSilent(id, before);
      },
    );

    it('E-7 / ANNOUNCE-API-5 AC-9 DEPARTMENT(soft-deleted, and with zero eligible members) → still 400 ANNOUNCEMENT_DEPARTMENT_INVALID, never a zero-recipient 200', async () => {
      // The department holds nobody at all, so if the department check were skipped this would be
      // exactly the zero-recipient 200 above. It must stay the 400.
      expect(
        await prisma.lineUserRegistration.count({
          where: { departmentId: dept.gone },
        }),
      ).toBe(0);
      const id = await seedAnnouncement({
        title: T('e7 gone'),
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: dept.gone,
      });
      const before = await rawRow(id);
      const res = await sendAs(ADMIN, id).expect(400);
      expect((res.body as CodedError).code).toBe(
        'ANNOUNCEMENT_DEPARTMENT_INVALID',
      );
      await expectUnchangedAndSilent(id, before);
    });

    it('E-7 DEPARTMENT with a null department (SetNull after a hard delete) → 400 ANNOUNCEMENT_DEPARTMENT_INVALID', async () => {
      const id = await seedAnnouncement({
        title: T('e7 null dept'),
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: null,
      });
      const before = await rawRow(id);
      const res = await sendAs(ADMIN, id).expect(400);
      expect((res.body as CodedError).code).toBe(
        'ANNOUNCEMENT_DEPARTMENT_INVALID',
      );
      await expectUnchangedAndSilent(id, before);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-8 — nothing accepted: DRAFT survives, and the same row sends later (AC-10)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  it('E-8 AC-10 — 401 → 503, 429 → 503, 5xx×2 / network×2 → 502; the row stays DRAFT each time, then sends with the SAME retry key', async () => {
    const id = await seedAnnouncement({
      title: T('e8 failures'),
      audience: AnnouncementAudience.DEPARTMENT,
      departmentId: dept.A,
    });
    const before = await rawRow(id);
    const keys: string[] = [];

    const attempt = async (
      setup: () => void,
      status: number,
      code: string,
      requests: number,
    ) => {
      fakeLine.multicast.mockReset();
      setup();
      const res = await sendAs(ADMIN, id).expect(status);
      expect((res.body as CodedError).code).toBe(code);
      expect(JSON.stringify(res.body)).not.toContain('from LINE');
      expect(fakeLine.multicast).toHaveBeenCalledTimes(requests);
      keys.push(...calls().map(([, key]) => key));

      const row = await rawRow(id);
      expect(row.status).toBe(AnnouncementStatus.DRAFT);
      expect(row.sentCount).toBe(0);
      expect(row.sentAt).toBeNull();
      expect(row.updatedAt).toEqual(before.updatedAt);
    };

    await attempt(
      () => fakeLine.multicast.mockRejectedValue(httpError(401)),
      503,
      'LINE_NOT_CONFIGURED',
      1,
    );
    await attempt(
      () => fakeLine.multicast.mockRejectedValue(httpError(429)),
      503,
      'LINE_RATE_LIMITED',
      1,
    );
    await attempt(
      () => fakeLine.multicast.mockRejectedValue(httpError(500)),
      502,
      'LINE_SEND_FAILED',
      2,
    );
    await attempt(
      () => fakeLine.multicast.mockRejectedValue(new TypeError('fetch failed')),
      502,
      'LINE_SEND_FAILED',
      2,
    );
    await attempt(
      () => fakeLine.multicast.mockRejectedValue(httpError(400)),
      502,
      'LINE_SEND_FAILED',
      1,
    );

    fakeLine.multicast.mockReset().mockResolvedValue({});
    const res = await sendAs(ADMIN, id).expect(200);
    expect((res.body as AnnouncementBody).status).toBe(AnnouncementStatus.SENT);
    keys.push(calls()[0][1]);

    // Unchanged content + unchanged members → one key across every attempt: a resend within 24 h
    // of a request LINE had in fact accepted would be answered 409 → accepted (D-B).
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(UUID_V5);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-9 — the lock, against real Postgres (AC-9, D-A, S-4)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-9 — concurrent sends', () => {
    it('E-9 while a send holds the lock: a second send → 409 SEND_IN_PROGRESS, a PATCH blocks and then → 409; one set of chunks, SENT once', async () => {
      const title = T('e9 lock');
      const id = await seedAnnouncement({
        title,
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: dept.A,
      });

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      fakeLine.multicast.mockImplementation(async () => {
        await gate;
        return {};
      });

      // `.then` starts a supertest request; A is now in flight.
      const sendA = sendAs(ADMIN, id).then((r) => r);
      const aHoldsLock = await waitFor(
        () => fakeLine.multicast.mock.calls.length === 1,
        15_000,
      );
      expect(aHoldsLock).toBe(true);

      // A is inside multicast, i.e. holding FOR UPDATE on the row. A second NOWAIT must fail fast.
      const b = await sendAs(SUPER, id);
      expect(b.status).toBe(409);
      expect((b.body as CodedError).code).toBe('ANNOUNCEMENT_SEND_IN_PROGRESS');

      // Phase 1's conditional write must BLOCK on the same lock (D-A.6).
      const patch = as(SUPER)
        .agent.patch(url(`/announcements/${id}`))
        .set('x-csrf-token', as(SUPER).token)
        .send({ title: T('e9 edited') })
        .then((r) => r);
      const patchBlocked = await waitFor(async () => {
        const [{ n }] = await prisma.$queryRaw<[{ n: number }]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query ILIKE '%announcements%'`;
        return n > 0;
      }, 10_000);

      release();
      const [a, p] = await Promise.all([sendA, patch]);

      expect(patchBlocked).toBe(true);
      expect(a.status).toBe(200);
      expect(p.status).toBe(409);
      expect((p.body as CodedError).message).toBe(ANNOUNCEMENT_SENT_IMMUTABLE);
      expect(fakeLine.multicast).toHaveBeenCalledTimes(1);

      const row = await rawRow(id);
      expect(row.status).toBe(AnnouncementStatus.SENT);
      expect(row.title).toBe(title); // the blocked PATCH did not land on the SENT row
      expect(row.sentCount).toBe(2);
    });

    it('E-9b Promise.all of two sends (slow LINE) → exactly one 200 and one 409', async () => {
      const id = await seedAnnouncement({
        title: T('e9b race'),
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: dept.A,
      });
      fakeLine.multicast.mockImplementation(
        () => new Promise((r) => setTimeout(() => r({}), 300)),
      );

      const [r1, r2] = await Promise.all([
        sendAs(ADMIN, id),
        sendAs(SUPER, id),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = (r1.status === 409 ? r1 : r2).body as CodedError;
      expect([
        'ANNOUNCEMENT_SEND_IN_PROGRESS',
        'ANNOUNCEMENT_ALREADY_SENT',
      ]).toContain(loser.code);
      expect(fakeLine.multicast).toHaveBeenCalledTimes(1);
      expect((await rawRow(id)).status).toBe(AnnouncementStatus.SENT);
    });

    it('ANNOUNCE-API-5 AC-4 — DELETE while a send holds the lock → 409 SEND_IN_PROGRESS AT ONCE; the send then commits SENT and not deleted; a DELETE afterwards → 204', async () => {
      const id = await seedAnnouncement({
        title: T('ac4 delete vs send'),
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: dept.A,
      });

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      fakeLine.multicast.mockImplementation(async () => {
        await gate;
        return {};
      });

      const sendA = sendAs(ADMIN, id).then((r) => r);
      try {
        const holdsLock = await waitFor(
          () => fakeLine.multicast.mock.calls.length === 1,
          15_000,
        );
        expect(holdsLock).toBe(true);

        // NOWAIT: answered while the send is still parked inside multicast — not after it.
        const t0 = Date.now();
        const d = await deleteAs(SUPER, id);
        const elapsed = Date.now() - t0;
        expect(d.status).toBe(409);
        expect(d.body).toEqual({
          statusCode: 409,
          error: 'Conflict',
          message:
            'This announcement is being sent or edited right now. Try again in a moment.',
          code: 'ANNOUNCEMENT_SEND_IN_PROGRESS',
        });
        expect(elapsed).toBeLessThan(2_000);
        expect(fakeLine.multicast).toHaveBeenCalledTimes(1); // the send is STILL in flight
      } finally {
        release();
      }

      const a = await sendA;
      expect(a.status).toBe(200);
      const sent = await rawRow(id);
      expect(sent.status).toBe(AnnouncementStatus.SENT);
      expect(sent.deletedAt).toBeNull(); // the refused DELETE hid nothing

      await deleteAs(SUPER, id).expect(204);
      const after = await rawRow(id);
      expect(after.deletedAt).not.toBeNull();
      expect(after.status).toBe(AnnouncementStatus.SENT);
      expect(after.sentCount).toBe(sent.sentCount);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-10 — RBAC / session / CSRF (AC-13)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-13 — RBAC, session and CSRF on send', () => {
    let id = '';
    let before: Awaited<ReturnType<typeof rawRow>>;

    beforeAll(async () => {
      id = await seedAnnouncement({ title: T('e10 target') });
      before = await rawRow(id);
    });

    afterEach(async () => {
      expect(fakeLine.multicast).not.toHaveBeenCalled();
      expect(await rawRow(id)).toEqual(before);
    });

    it('VIEWER with a valid CSRF token → 403', async () => {
      await sendAs(VIEWER, id).expect(403);
    });

    it('no session (but a valid CSRF pair) → 401', async () => {
      const agent = request.agent(server());
      const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
      const token = (csrf.body as { csrfToken: string }).csrfToken;
      await agent
        .post(url(`/announcements/${id}/send`))
        .set('x-csrf-token', token)
        .expect(401);
    });

    it('no session AND no CSRF token → 403 (CSRF runs before the guards)', async () => {
      await request(server())
        .post(url(`/announcements/${id}/send`))
        .expect(403);
    });

    it('ADMIN without x-csrf-token → 403', async () => {
      const res = await as(ADMIN)
        .agent.post(url(`/announcements/${id}/send`))
        .expect(403);
      expect((res.body as CodedError).message).toBe(INVALID_CSRF_TOKEN);
    });

    it('ADMIN with a forged x-csrf-token → 403', async () => {
      const res = await as(ADMIN)
        .agent.post(url(`/announcements/${id}/send`))
        .set('x-csrf-token', 'forged-token')
        .expect(403);
      expect((res.body as CodedError).message).toBe(INVALID_CSRF_TOKEN);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-11 — /docs-json (AC-15)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-15 — /docs-json', () => {
    type Operation = {
      responses: Record<string, { content?: unknown }>;
      tags?: string[];
      description?: string;
    };
    type Schema = {
      enum?: string[];
      properties?: Record<string, { description?: string }>;
      required?: string[];
    };
    type Doc = {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, Schema> };
    };
    let doc: Doc;

    beforeAll(() => {
      // `createE2eApp` does not mount Swagger (main.ts does), so build the same document here.
      doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      ) as unknown as Doc;
    });

    it('documents GET line-bot-info (200/401/403/503) and POST :id/send (200/400/401/403/404/409/502/503)', () => {
      const info = doc.paths[`${API_BASE_PATH}/announcements/line-bot-info`];
      const send = doc.paths[`${API_BASE_PATH}/announcements/{id}/send`];

      expect(Object.keys(info.get.responses).sort()).toEqual(
        ['200', '401', '403', '503'].sort(),
      );
      expect(Object.keys(send.post.responses).sort()).toEqual(
        ['200', '400', '401', '403', '404', '409', '502', '503'].sort(),
      );
      expect(send.post.responses).not.toHaveProperty('201');
      expect(info.get.tags).toEqual(['Announcements']);
      expect(send.post.tags).toEqual(['Announcements']);
      expect(send.post.description).toContain('ANNOUNCEMENT_PARTIALLY_SENT');
      expect(send.post.description).toContain('Irreversible');

      const ref = (op: Operation, status: string) =>
        JSON.stringify(op.responses[status]);
      for (const status of ['400', '404', '409', '502', '503']) {
        expect(ref(send.post, status)).toContain('AnnouncementCodedErrorDto');
      }
      expect(ref(info.get, '503')).toContain('AnnouncementCodedErrorDto');
      expect(ref(info.get, '200')).toContain('LineBotInfoDto');
      expect(ref(send.post, '200')).toContain('AnnouncementDto');
    });

    it('ANNOUNCE-API-5 — the send description documents the zero-recipient 200; DELETE documents 204 + coded 404/409 and the soft delete', () => {
      const send = doc.paths[`${API_BASE_PATH}/announcements/{id}/send`].post;
      expect(send.description).toContain('`sentCount` 0');
      expect(send.description).toContain('no LINE call');
      expect(send.description).toContain(
        'zero eligible recipients after every filter',
      );
      expect(JSON.stringify(send.responses['200'])).toContain('sentCount` 0');

      const del = doc.paths[`${API_BASE_PATH}/announcements/{id}`]
        .delete as Operation & { summary?: string };
      expect(Object.keys(del.responses)).toEqual(
        expect.arrayContaining(['204', '404', '409']),
      );
      expect(JSON.stringify(del.responses['404'])).toContain(
        'AnnouncementCodedErrorDto',
      );
      expect(JSON.stringify(del.responses['409'])).toContain(
        'AnnouncementCodedErrorDto',
      );
      expect(del.description).toMatch(/soft/i);
      expect(del.description).toContain('ANNOUNCEMENT_SEND_IN_PROGRESS');
    });

    it('publishes the schemas, the 10-value AnnouncementErrorCode (AC-10: the zero-recipient code is gone), and the sentCount semantics', () => {
      const s = doc.components.schemas;
      expect(Object.keys(s.LineBotInfoDto.properties ?? {}).sort()).toEqual(
        ['basicId', 'chatMode', 'displayName', 'pictureUrl'].sort(),
      );
      expect(s.LineBotChatMode?.enum).toEqual(['chat', 'bot']);
      expect(Object.keys(s.AnnouncementCodedErrorDto.properties ?? {})).toEqual(
        expect.arrayContaining([
          'statusCode',
          'error',
          'message',
          'code',
          'acceptedCount',
          'targetedCount',
        ]),
      );
      expect(s.AnnouncementErrorCode?.enum).toEqual([
        ...ANNOUNCEMENT_ERROR_CODES,
      ]);
      // ANNOUNCE-API-5 AC-10 — this assertion lives in `test/`, because the token must appear nowhere
      // in `src/`.
      expect(s.AnnouncementErrorCode?.enum).toEqual([
        'ANNOUNCEMENT_NOT_FOUND',
        'ANNOUNCEMENT_ALREADY_SENT',
        'ANNOUNCEMENT_SEND_IN_PROGRESS',
        'ANNOUNCEMENT_BODY_REQUIRED',
        'ANNOUNCEMENT_DEPARTMENT_INVALID',
        'ANNOUNCEMENT_PARTIALLY_SENT',
        'LINE_SEND_FAILED',
        'LINE_NOT_CONFIGURED',
        'LINE_RATE_LIMITED',
        'LINE_BOT_INFO_UNAVAILABLE',
      ]);
      expect(s.AnnouncementErrorCode?.enum).toHaveLength(10);
      expect(s.AnnouncementErrorCode?.enum).not.toContain(
        'NO_RECIPIENTS_FOUND',
      );
      expect(JSON.stringify(doc)).not.toContain('NO_RECIPIENTS_FOUND');
      expect(s.AnnouncementDto.properties?.sentCount?.description).toContain(
        'accepted',
      );
      expect(s.AnnouncementStatus?.enum).toEqual(['DRAFT', 'SENT']);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-12 — LAST: nothing reached LINE, nothing leaked into a log (AC-14)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-14 — the suite never reached LINE and never logged PII', () => {
    it('E-12 the fetch tripwire recorded no request to *.line.me', () => {
      expect(lineHits).toEqual([]);
    });

    it('no log line carried a fixture LINE id, an announcement title or a body', () => {
      const lines = logSpies
        .flatMap((s) =>
          (s.mock.calls as unknown[][]).map((c) => c.map(String).join(' ')),
        )
        .join('\n');
      expect(lines).toContain('Announcement sent id='); // the spies do see the service
      for (const lineUserId of Object.values(fx)) {
        expect(lines).not.toContain(lineUserId);
      }
      expect(lines).not.toContain(RUN); // every title and body carries the run token
      expect(lines).not.toMatch(/U[0-9a-f]{32}/);
    });
  });
});
