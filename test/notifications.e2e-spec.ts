import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  AdminNotificationCategory,
  AdminNotificationTargetRole,
  AdminNotificationTone,
  SystemRole,
} from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MUST_CHANGE_PASSWORD } from '../src/auth/auth.constants';
import { PasswordService } from '../src/auth/password.service';
import { bangkokDayRange } from '../src/bookings/booking-code';
import { API_BASE_PATH } from '../src/common/api.constants';
import { INVALID_CSRF_TOKEN } from '../src/csrf/csrf.service';
import {
  ADMIN_NOTIFICATION_ICONS,
  NOTIFICATION_DISMISS_TARGET,
  NOTIFICATION_NOT_FOUND,
} from '../src/notifications/notifications.constants';
import { NotificationsService } from '../src/notifications/notifications.service';
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
 * `NOTIF-API-1` — admin notifications, phase 1 (`/notifications`), plan AC-2…AC-20.
 *
 * 🔴 THIS RUNS AGAINST THE SHARED DEV DATABASE, which may hold seeded (`cseednotif…`) or real
 * notifications. So:
 * - every fixture notification's `code` starts with `e2e-notif-`, every operator's email with
 *   `e2e-notifsu-`, and cleanup deletes by exactly those two prefixes — never a TRUNCATE;
 * - every list assertion is narrowed by a per-block search token, or asserted PER ID;
 * - global numbers (the unread count) are only ever compared RELATIVELY — to another endpoint read
 *   at the same moment, or as a before/after delta — never to an absolute total;
 * - the "mark/dismiss EVERYTHING" routes are driven by operators that exist only for that
 *   (`reader`, `dismisser`), so their blast radius is their own receipts;
 * - AC-20 snapshots every non-fixture notification and every non-e2e operator's receipt up front
 *   and proves, at the end, that not one of them moved.
 */

const SU_PREFIX = 'e2e-notifsu-';
const CODE_PREFIX = 'e2e-notif-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN_X = `${SU_PREFIX}adminx@easybook.local`;
const ADMIN_Y = `${SU_PREFIX}adminy@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;
const DEMOTED = `${SU_PREFIX}demoted@easybook.local`;
const READER = `${SU_PREFIX}reader@easybook.local`;
const DISMISSER = `${SU_PREFIX}dismisser@easybook.local`;
const GATED = `${SU_PREFIX}gated@easybook.local`;

const { BOOKING, REGISTRATION, FEEDBACK, SYSTEM } = AdminNotificationCategory;
const { ALL, ADMIN, SUPER_ADMIN } = AdminNotificationTargetRole;

/** Fixed, long-past instants — outside every `period` window, so only the AC-8 block sees `period`. */
const T0 = Date.UTC(2026, 0, 5, 3, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/** A cuid-shaped id that exists nowhere. */
const GHOST_ID = 'cnotarealnotification0000';
const cuidLike = (n: number) => `c${String(n).padStart(24, '0')}`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface Item {
  id: string;
  category: AdminNotificationCategory;
  code: string | null;
  title: string;
  body: string;
  tone: AdminNotificationTone;
  icon: string;
  actionUrl: string | null;
  actionLabel: string | null;
  targetRole: AdminNotificationTargetRole;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListBody {
  data: Item[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface CountBody {
  total: number;
  byCategory: Record<AdminNotificationCategory, number>;
}

describe('Admin notifications (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  const userIds: Record<string, string> = {};
  const sessions: Record<string, Session> = {};
  let seq = 0;

  /** AC-20 — what existed before this suite touched anything. */
  let foreignNotifications: Array<{ id: string; updatedAt: Date }> = [];
  let foreignReceipts: unknown[] = [];

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

  const as = (email: string) => sessions[email];

  const list = async (email: string, qs = ''): Promise<ListBody> =>
    (
      await as(email)
        .agent.get(url(`/notifications${qs}`))
        .expect(200)
    ).body as ListBody;

  /** `?search=<token>` plus any extra query. */
  const search = (email: string, token: string, extra = '') =>
    list(email, `?search=${encodeURIComponent(token)}&limit=50${extra}`);

  const idsOf = (body: ListBody) => body.data.map((r) => r.id);

  const unread = async (email: string): Promise<CountBody> =>
    (await as(email).agent.get(url('/notifications/unread-count')).expect(200))
      .body as CountBody;

  const patchState = (email: string, id: string, which: 'read' | 'unread') =>
    as(email)
      .agent.patch(url(`/notifications/${id}/${which}`))
      .set('x-csrf-token', as(email).token);

  const readAll = (email: string, body?: unknown) => {
    const req = as(email)
      .agent.post(url('/notifications/read-all'))
      .set('x-csrf-token', as(email).token);
    return body === undefined ? req : req.send(body as object);
  };

  const bulk = (email: string, body?: unknown) => {
    const req = as(email)
      .agent.delete(url('/notifications/bulk'))
      .set('x-csrf-token', as(email).token);
    return body === undefined ? req : req.send(body as object);
  };

  const receipt = (email: string, notificationId: string) =>
    prisma.adminNotificationReceipt.findUnique({
      where: {
        systemUserId_notificationId: {
          systemUserId: userIds[email],
          notificationId,
        },
      },
      select: { readAt: true, dismissedAt: true },
    });

  const receiptCount = (email: string) =>
    prisma.adminNotificationReceipt.count({
      where: { systemUserId: userIds[email] },
    });

  /** Fixture notifications go straight through Prisma — never over HTTP (there is no create route). */
  const seed = async (opts: {
    token: string;
    targetRole?: AdminNotificationTargetRole;
    category?: AdminNotificationCategory;
    createdAt?: Date;
    title?: string;
    body?: string;
    code?: string;
  }): Promise<string> => {
    const n = ++seq;
    const row = await prisma.adminNotification.create({
      data: {
        code: opts.code ?? `${CODE_PREFIX}${String(n).padStart(4, '0')}`,
        category: opts.category ?? BOOKING,
        title: opts.title ?? `${opts.token} fixture ${n}`,
        body: opts.body ?? 'รายละเอียดทั่วไป',
        tone: AdminNotificationTone.SKY,
        icon: 'calendar',
        targetRole: opts.targetRole ?? ALL,
        createdAt: opts.createdAt ?? at(n),
      },
      select: { id: true },
    });
    return row.id;
  };

  /** Raw SQL, by prefix only: receipts go with their notification (Cascade). Never a TRUNCATE. */
  const purgeFixtures = async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM admin_notifications WHERE code LIKE '${CODE_PREFIX}%'`,
    );
  };

  const snapshotForeign = async () => {
    const notifications = await prisma.adminNotification.findMany({
      where: {
        OR: [{ code: null }, { NOT: { code: { startsWith: CODE_PREFIX } } }],
      },
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    const receipts = await prisma.adminNotificationReceipt.findMany({
      where: { systemUser: { NOT: { email: { startsWith: SU_PREFIX } } } },
      orderBy: [{ systemUserId: 'asc' }, { notificationId: 'asc' }],
    });
    return { notifications, receipts };
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);

    await purgeFixtures();
    await purgeE2eUsers(prisma, SU_PREFIX);

    const before = await snapshotForeign();
    foreignNotifications = before.notifications;
    foreignReceipts = before.receipts;

    const options = await ensureE2eOptions(prisma);
    const passwordHash = await new PasswordService().hash(PASSWORD);
    for (const [email, role, mustChangePassword] of [
      [SUPER, SystemRole.SUPER_ADMIN, false],
      [ADMIN_X, SystemRole.ADMIN, false],
      [ADMIN_Y, SystemRole.ADMIN, false],
      [VIEWER, SystemRole.VIEWER, false],
      [DEMOTED, SystemRole.ADMIN, false],
      [READER, SystemRole.ADMIN, false],
      [DISMISSER, SystemRole.ADMIN, false],
      [GATED, SystemRole.ADMIN, true],
    ] as Array<[string, SystemRole, boolean]>) {
      const row = await prisma.systemUser.create({
        data: {
          email,
          firstName: 'E2E',
          lastName: role,
          role,
          passwordHash,
          mustChangePassword,
          ...options,
        },
        select: { id: true },
      });
      userIds[email] = row.id;
    }
    for (const email of [
      SUPER,
      ADMIN_X,
      ADMIN_Y,
      VIEWER,
      DEMOTED,
      READER,
      DISMISSER,
      GATED,
    ]) {
      sessions[email] = await login(email);
    }
  });

  afterAll(async () => {
    await purgeFixtures();
    await purgeE2eUsers(prisma, SU_PREFIX);
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-2 — auth, CSRF and the password gate
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-2 — authentication and CSRF', () => {
    const TOKEN = 'zqnotifauth';
    let target = '';

    beforeAll(async () => {
      target = await seed({ token: TOKEN });
    });

    it.each([
      ['get', '/notifications'],
      ['get', '/notifications/unread-count'],
    ] as const)('%s %s with no session → 401', async (method, path) => {
      await request(server())[method](url(path)).expect(401);
    });

    it.each([
      ['post', '/notifications/read-all', {}],
      ['delete', '/notifications/bulk', { allRead: true }],
      ['patch', '/notifications/:id/read', undefined],
      ['patch', '/notifications/:id/unread', undefined],
    ] as const)(
      '%s %s with no session (but a valid CSRF pair) → 401, nothing written',
      async (method, path, body) => {
        const agent = request.agent(server());
        const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
        const req = agent[method](url(path.replace(':id', target))).set(
          'x-csrf-token',
          (csrf.body as { csrfToken: string }).csrfToken,
        );
        await (body === undefined ? req : req.send(body)).expect(401);
        expect(
          await prisma.adminNotificationReceipt.count({
            where: { notificationId: target },
          }),
        ).toBe(0);
      },
    );

    it.each([
      ['post', '/notifications/read-all', true],
      ['delete', '/notifications/bulk', true],
      ['patch', '/notifications/:id/read', false],
      ['patch', '/notifications/:id/unread', false],
    ] as const)(
      '%s %s logged in WITHOUT x-csrf-token → 403, nothing written',
      async (method, path, takesIds) => {
        const req = as(ADMIN_X).agent[method](url(path.replace(':id', target)));
        const res = await (takesIds ? req.send({ ids: [target] }) : req).expect(
          403,
        );
        expect((res.body as { message: string }).message).toBe(
          INVALID_CSRF_TOKEN,
        );
        expect(await receipt(ADMIN_X, target)).toBeNull();
      },
    );

    it('a forged x-csrf-token → 403, nothing written', async () => {
      await as(ADMIN_X)
        .agent.patch(url(`/notifications/${target}/read`))
        .set('x-csrf-token', 'forged-token')
        .expect(403);
      expect(await receipt(ADMIN_X, target)).toBeNull();
    });

    it('the forced-password-change gate applies to every route (403, never exempt)', async () => {
      const gated = as(GATED);
      for (const res of [
        await gated.agent.get(url('/notifications')),
        await gated.agent.get(url('/notifications/unread-count')),
        await gated.agent
          .post(url('/notifications/read-all'))
          .set('x-csrf-token', gated.token),
        await gated.agent
          .patch(url(`/notifications/${target}/read`))
          .set('x-csrf-token', gated.token),
      ]) {
        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toBe(
          MUST_CHANGE_PASSWORD,
        );
      }
      expect(await receiptCount(GATED)).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-3 — role visibility on the list
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-3 — role visibility (list)', () => {
    const TOKEN = 'zqnotifvis';
    const f = { a: '', b: '', c: '' };

    beforeAll(async () => {
      f.a = await seed({ token: TOKEN, targetRole: ALL, category: BOOKING });
      f.b = await seed({
        token: TOKEN,
        targetRole: ADMIN,
        category: REGISTRATION,
      });
      f.c = await seed({
        token: TOKEN,
        targetRole: SUPER_ADMIN,
        category: SYSTEM,
      });
    });

    it('SUPER_ADMIN sees A (ALL), B (ADMIN) and C (SUPER_ADMIN)', async () => {
      const body = await search(SUPER, TOKEN);
      expect(idsOf(body).sort()).toEqual([f.a, f.b, f.c].sort());
      expect(body.meta.total).toBe(3);
    });

    it('ADMIN sees A and B, never C', async () => {
      const body = await search(ADMIN_X, TOKEN);
      expect(idsOf(body).sort()).toEqual([f.a, f.b].sort());
      expect(body.meta.total).toBe(2);
    });

    it('VIEWER sees A only', async () => {
      const body = await search(VIEWER, TOKEN);
      expect(idsOf(body)).toEqual([f.a]);
      expect(body.meta.total).toBe(1);
    });

    it('an item carries the model fields + the CALLER’s isRead/readAt, and nothing private', async () => {
      const [item] = (await search(VIEWER, TOKEN)).data;
      expect(Object.keys(item).sort()).toEqual(
        [
          'actionLabel',
          'actionUrl',
          'body',
          'category',
          'code',
          'createdAt',
          'icon',
          'id',
          'isRead',
          'readAt',
          'targetRole',
          'title',
          'tone',
          'updatedAt',
        ].sort(),
      );
      expect(item).toMatchObject({
        id: f.a,
        targetRole: ALL,
        isRead: false,
        readAt: null,
        actionUrl: null,
        actionLabel: null,
      });
    });

    it('the unread count is role-scoped the same way (C counts for SUPER_ADMIN only)', async () => {
      const superBefore = await unread(SUPER);
      const adminBefore = await unread(ADMIN_X);
      const viewerBefore = await unread(VIEWER);
      const extra = await seed({
        token: TOKEN,
        targetRole: SUPER_ADMIN,
        category: FEEDBACK,
      });
      expect((await unread(SUPER)).byCategory.FEEDBACK).toBe(
        superBefore.byCategory.FEEDBACK + 1,
      );
      expect(await unread(ADMIN_X)).toEqual(adminBefore);
      expect(await unread(VIEWER)).toEqual(viewerBefore);
      await prisma.adminNotification.delete({ where: { id: extra } });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-4 — role visibility on every mutation
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-4 — role visibility (mutations)', () => {
    const TOKEN = 'zqnotifmut';
    const f = { a: '', b: '', c: '' };

    beforeAll(async () => {
      f.a = await seed({ token: TOKEN, targetRole: ALL });
      f.b = await seed({ token: TOKEN, targetRole: ADMIN });
      f.c = await seed({ token: TOKEN, targetRole: SUPER_ADMIN });
    });

    it.each(['read', 'unread'] as const)(
      'ADMIN PATCH C/%s → 404 (never 403), nothing written',
      async (which) => {
        const res = await patchState(ADMIN_X, f.c, which).expect(404);
        expect((res.body as { message: string }).message).toBe(
          NOTIFICATION_NOT_FOUND,
        );
        expect(await receipt(ADMIN_X, f.c)).toBeNull();
      },
    );

    it.each(['read', 'unread'] as const)(
      'VIEWER PATCH B/%s → 404, nothing written',
      async (which) => {
        await patchState(VIEWER, f.b, which).expect(404);
        expect(await receipt(VIEWER, f.b)).toBeNull();
      },
    );

    it.each([
      ['an unknown (cuid-shaped) id', GHOST_ID],
      ['a malformed id (404, never 400)', 'not-a-cuid'],
      ['a seed-style non-cuid id', 'seed_notif_01'],
    ])('%s → the same 404', async (_label, id) => {
      for (const which of ['read', 'unread'] as const) {
        const res = await patchState(ADMIN_X, id, which).expect(404);
        expect((res.body as { message: string }).message).toBe(
          NOTIFICATION_NOT_FOUND,
        );
      }
    });

    it('E-5 {ids:[C]} by ADMIN → {updated:0}, C’s state unchanged (no existence oracle)', async () => {
      const res = await readAll(ADMIN_X, { ids: [f.c] }).expect(200);
      expect(res.body).toEqual({ updated: 0 });
      expect(await receipt(ADMIN_X, f.c)).toBeNull();
    });

    it('E-6 {ids:[C]} by ADMIN → {deleted:0}; E-6 {ids:[B]} by VIEWER → {deleted:0}', async () => {
      await bulk(ADMIN_X, { ids: [f.c] })
        .expect(200)
        .expect({ deleted: 0 });
      expect(await receipt(ADMIN_X, f.c)).toBeNull();
      await bulk(VIEWER, { ids: [f.b] })
        .expect(200)
        .expect({ deleted: 0 });
      expect(await receipt(VIEWER, f.b)).toBeNull();
    });

    it('mixed visible + invisible ids: only the visible ones change and count', async () => {
      const res = await readAll(ADMIN_Y, {
        ids: [f.a, f.b, f.c, GHOST_ID],
      }).expect(200);
      expect(res.body).toEqual({ updated: 2 });
      expect((await receipt(ADMIN_Y, f.a))?.readAt).toBeInstanceOf(Date);
      expect((await receipt(ADMIN_Y, f.b))?.readAt).toBeInstanceOf(Date);
      expect(await receipt(ADMIN_Y, f.c)).toBeNull();
    });

    it('SUPER_ADMIN may act on C', async () => {
      const res = await patchState(SUPER, f.c, 'read').expect(200);
      expect((res.body as Item).isRead).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Demotion — visibility follows the SESSION role, re-read every request
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('edge — an ADMIN demoted to VIEWER mid-session', () => {
    const TOKEN = 'zqnotifdemo';
    let adminOnly = '';
    let forAll = '';

    beforeAll(async () => {
      adminOnly = await seed({ token: TOKEN, targetRole: ADMIN });
      forAll = await seed({ token: TOKEN, targetRole: ALL });
    });

    afterAll(async () => {
      await prisma.systemUser.update({
        where: { id: userIds[DEMOTED] },
        data: { role: SystemRole.ADMIN },
      });
    });

    it('loses ADMIN items on the very next request; old state rows stay but are unreachable', async () => {
      expect(idsOf(await search(DEMOTED, TOKEN)).sort()).toEqual(
        [adminOnly, forAll].sort(),
      );
      await patchState(DEMOTED, adminOnly, 'read').expect(200);

      await prisma.systemUser.update({
        where: { id: userIds[DEMOTED] },
        data: { role: SystemRole.VIEWER },
      });

      expect(idsOf(await search(DEMOTED, TOKEN))).toEqual([forAll]);
      expect(idsOf(await search(DEMOTED, TOKEN, '&isRead=true'))).toEqual([]);
      await patchState(DEMOTED, adminOnly, 'unread').expect(404);
      await bulk(DEMOTED, { ids: [adminOnly] })
        .expect(200)
        .expect({ deleted: 0 });
      // The row survives, untouched, for the day the role comes back.
      expect((await receipt(DEMOTED, adminOnly))?.readAt).toBeInstanceOf(Date);
      expect((await receipt(DEMOTED, adminOnly))?.dismissedAt).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-5 — read state is per operator
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-5 — per-operator read state', () => {
    const TOKEN = 'zqnotifperop';
    let a = '';

    beforeAll(async () => {
      a = await seed({ token: TOKEN, targetRole: ALL, category: FEEDBACK });
    });

    it('X marks A read: read for X, still unread for Y, and Y’s count does not move', async () => {
      const yBefore = await unread(ADMIN_Y);
      const xBefore = await unread(ADMIN_X);

      const res = await patchState(ADMIN_X, a, 'read').expect(200);
      expect(res.body).toMatchObject({ id: a, isRead: true });

      const [forX] = (await search(ADMIN_X, TOKEN)).data;
      const [forY] = (await search(ADMIN_Y, TOKEN)).data;
      expect(forX).toMatchObject({ id: a, isRead: true });
      expect(forX.readAt).not.toBeNull();
      expect(forY).toMatchObject({ id: a, isRead: false, readAt: null });

      expect(await unread(ADMIN_Y)).toEqual(yBefore);
      const xAfter = await unread(ADMIN_X);
      expect(xAfter.total).toBe(xBefore.total - 1);
      expect(xAfter.byCategory.FEEDBACK).toBe(xBefore.byCategory.FEEDBACK - 1);
      expect(await receipt(ADMIN_Y, a)).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-6 — the unread count agrees with the list
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-6 — unread count', () => {
    const TOKEN = 'zqnotifcount';

    beforeAll(async () => {
      await seed({ token: TOKEN, targetRole: ALL, category: FEEDBACK });
      await seed({ token: TOKEN, targetRole: ALL, category: SYSTEM });
      await seed({ token: TOKEN, targetRole: ADMIN, category: REGISTRATION });
    });

    it.each([SUPER, ADMIN_X, ADMIN_Y, VIEWER])(
      '%s: total == Σ byCategory == GET ?isRead=false meta.total',
      async (email) => {
        const count = await unread(email);
        const sum = Object.values(count.byCategory).reduce((n, c) => n + c, 0);
        expect(Object.keys(count.byCategory).sort()).toEqual(
          [BOOKING, FEEDBACK, REGISTRATION, SYSTEM].sort(),
        );
        expect(count.total).toBe(sum);
        const listed = await list(email, '?isRead=false&limit=1');
        expect(listed.meta.total).toBe(count.total);
      },
    );

    it('per category, the count equals the list narrowed to that category', async () => {
      const count = await unread(ADMIN_Y);
      for (const category of Object.values(AdminNotificationCategory)) {
        const listed = await list(
          ADMIN_Y,
          `?isRead=false&category=${category}&limit=1`,
        );
        expect(listed.meta.total).toBe(count.byCategory[category]);
      }
    });

    it('ignores every list filter (they are not part of this route)', async () => {
      const plain = await unread(ADMIN_Y);
      const res = await as(ADMIN_Y)
        .agent.get(
          url('/notifications/unread-count?category=BOOKING&isRead=true'),
        )
        .expect(200);
      expect(res.body).toEqual(plain);
    });

    it('a new unread notification moves the right bucket by exactly one', async () => {
      const before = await unread(VIEWER);
      const id = await seed({
        token: TOKEN,
        targetRole: ALL,
        category: BOOKING,
      });
      const after = await unread(VIEWER);
      expect(after.total).toBe(before.total + 1);
      expect(after.byCategory.BOOKING).toBe(before.byCategory.BOOKING + 1);
      await prisma.adminNotification.delete({ where: { id } });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-7 — filters, and `isRead=false` is not `true`
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-7 — filters', () => {
    const TOKEN = 'zqnotiffilt';
    const f = { r: '', u: '', ub: '' };

    beforeAll(async () => {
      f.r = await seed({ token: TOKEN, category: BOOKING });
      f.u = await seed({ token: TOKEN, category: FEEDBACK });
      f.ub = await seed({ token: TOKEN, category: BOOKING });
      await patchState(ADMIN_X, f.r, 'read').expect(200);
    });

    it('category narrows', async () => {
      expect(
        idsOf(await search(ADMIN_X, TOKEN, '&category=BOOKING')).sort(),
      ).toEqual([f.r, f.ub].sort());
      expect(idsOf(await search(ADMIN_X, TOKEN, '&category=FEEDBACK'))).toEqual(
        [f.u],
      );
    });

    it('isRead=true → only the caller’s read row', async () => {
      expect(idsOf(await search(ADMIN_X, TOKEN, '&isRead=true'))).toEqual([
        f.r,
      ]);
    });

    it('🔴 isRead=false → only the unread rows (it does NOT behave like true)', async () => {
      const ids = idsOf(await search(ADMIN_X, TOKEN, '&isRead=false'));
      expect(ids.sort()).toEqual([f.u, f.ub].sort());
      expect(ids).not.toContain(f.r);
    });

    it('filters combine with AND', async () => {
      expect(
        idsOf(await search(ADMIN_X, TOKEN, '&isRead=false&category=BOOKING')),
      ).toEqual([f.ub]);
      expect(
        idsOf(await search(ADMIN_X, TOKEN, '&isRead=true&category=FEEDBACK')),
      ).toEqual([]);
    });

    it('read state is the CALLER’s: another operator has nothing read', async () => {
      expect(idsOf(await search(ADMIN_Y, TOKEN, '&isRead=true'))).toEqual([]);
    });

    it.each([
      ['isRead=1'],
      ['isRead=yes'],
      ['isRead='],
      ['isRead=true&isRead=false'],
      ['category=bookings'],
      ['period=week'],
      ['systemUserId=x'],
      ['q=x'],
    ])('?%s → 400', async (qs) => {
      await as(ADMIN_X)
        .agent.get(url(`/notifications?${qs}`))
        .expect(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-8 — period, in Bangkok calendar days, against the real clock
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-8 — period (Asia/Bangkok days)', () => {
    const TOKEN = 'zqnotifperiod';
    const f = { today: '', lateYesterday: '', eightDays: '', fortyDays: '' };

    beforeAll(async () => {
      const { start } = bangkokDayRange(new Date());
      const DAY = 86_400_000;
      f.today = await seed({
        token: TOKEN,
        createdAt: new Date(start.getTime() + 5 * 60_000), // 00:05 Bangkok today
      });
      f.lateYesterday = await seed({
        token: TOKEN,
        createdAt: new Date(start.getTime() - 30 * 60_000), // 23:30 Bangkok yesterday
      });
      f.eightDays = await seed({
        token: TOKEN,
        createdAt: new Date(start.getTime() - 8 * DAY + 3_600_000),
      });
      f.fortyDays = await seed({
        token: TOKEN,
        createdAt: new Date(start.getTime() - 40 * DAY),
      });
    });

    it('today → 00:05 Bangkok today is in; 23:30 Bangkok yesterday is out', async () => {
      expect(idsOf(await search(ADMIN_X, TOKEN, '&period=today'))).toEqual([
        f.today,
      ]);
    });

    it('7d → today plus the seven days before it', async () => {
      expect(idsOf(await search(ADMIN_X, TOKEN, '&period=7d'))).toEqual([
        f.today,
        f.lateYesterday,
      ]);
    });

    it('30d → adds the 8-day-old row, not the 40-day-old one', async () => {
      expect(idsOf(await search(ADMIN_X, TOKEN, '&period=30d'))).toEqual([
        f.today,
        f.lateYesterday,
        f.eightDays,
      ]);
    });

    it('absent → all time', async () => {
      expect(idsOf(await search(ADMIN_X, TOKEN))).toEqual([
        f.today,
        f.lateYesterday,
        f.eightDays,
        f.fortyDays,
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-9 — search
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-9 — search', () => {
    const f = {
      title: '',
      body: '',
      code: '',
      thai: '',
      literal: '',
      wildcardBait: '',
    };

    beforeAll(async () => {
      f.title = await seed({
        token: 'x',
        title: 'ZqNotifSrchTitle ตรวจสอบ',
      });
      f.body = await seed({
        token: 'x',
        title: 'ไม่มีคำค้น',
        body: 'รายละเอียด zqnotifsrchbody ท้ายข้อความ',
      });
      f.code = await seed({
        token: 'x',
        title: 'ไม่มีคำค้น',
        code: `${CODE_PREFIX}ZQSRCHCODE-0001`,
      });
      f.thai = await seed({
        token: 'x',
        title: 'แอร์ซีคิวโนติฟ ห้องประชุม ชั้น 2',
      });
      f.literal = await seed({ token: 'x', title: 'zqpct_%x literal' });
      f.wildcardBait = await seed({ token: 'x', title: 'zqpctAAAx bait' });
    });

    it.each([
      ['a title substring, case-insensitively', 'zqnotifsrchtitle', 'title'],
      ['a body substring, case-insensitively', 'ZQNOTIFSRCHBODY', 'body'],
      ['a code substring', 'zqsrchcode', 'code'],
      ['a code with a leading #', '#e2e-notif-ZQSRCHCODE', 'code'],
      ['Thai text', 'ซีคิวโนติฟ', 'thai'],
      // Stored `แ` (SARA AE); typed as `เ` + `เ` — the query is sanitised the way the store is.
      ['Thai text typed with a double SARA E', 'เเอร์ซีคิวโนติฟ', 'thai'],
    ] as const)('finds %s', async (_label, term, key) => {
      const body = await list(
        ADMIN_X,
        `?search=${encodeURIComponent(term)}&limit=50`,
      );
      expect(idsOf(body)).toEqual([f[key]]);
    });

    it('% and _ are literal characters, not LIKE wildcards', async () => {
      const body = await list(
        ADMIN_X,
        `?search=${encodeURIComponent('zqpct_%x')}&limit=50`,
      );
      expect(idsOf(body)).toEqual([f.literal]);
      expect(idsOf(body)).not.toContain(f.wildcardBait);
    });

    it('whitespace-only and a bare # are ignored (the same page as no search)', async () => {
      const plain = await list(ADMIN_X, '?limit=1');
      for (const term of ['   ', '#', ' # ']) {
        const body = await list(
          ADMIN_X,
          `?search=${encodeURIComponent(term)}&limit=1`,
        );
        expect(body.meta.total).toBe(plain.meta.total);
      }
    });

    it('over 100 characters → 400; exactly 100 → 200', async () => {
      await as(ADMIN_X)
        .agent.get(url(`/notifications?search=${'a'.repeat(101)}`))
        .expect(400);
      await as(ADMIN_X)
        .agent.get(url(`/notifications?search=${'a'.repeat(100)}`))
        .expect(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-10 — pagination and a stable total order
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-10 — pagination', () => {
    const TOKEN = 'zqnotifpage';
    let expected: string[] = [];
    let ties: string[] = [];

    beforeAll(async () => {
      const distinct: string[] = [];
      for (let i = 5; i >= 1; i -= 1) {
        distinct.push(await seed({ token: TOKEN, createdAt: at(1000 + i) }));
      }
      // Two rows at the SAME instant: the `id DESC` tie-break decides.
      ties = [
        await seed({ token: TOKEN, createdAt: at(1000) }),
        await seed({ token: TOKEN, createdAt: at(1000) }),
      ].sort((a, b) => (a < b ? 1 : -1));
      expected = [...distinct, ...ties];
    });

    it('orders createdAt DESC, id DESC — a total order', async () => {
      expect(idsOf(await search(ADMIN_X, TOKEN))).toEqual(expected);
    });

    it('pages of 3 concatenate to the full list with no gap or duplicate; past the end is 200 []', async () => {
      const pages: string[] = [];
      for (const page of [1, 2, 3]) {
        const body = await list(
          ADMIN_X,
          `?search=${TOKEN}&limit=3&page=${page}`,
        );
        expect(body.meta).toEqual({ page, limit: 3, total: 7, totalPages: 3 });
        pages.push(...idsOf(body));
      }
      expect(pages).toEqual(expected);

      const past = await list(ADMIN_X, `?search=${TOKEN}&limit=3&page=4`);
      expect(past.data).toEqual([]);
      expect(past.meta).toEqual({ page: 4, limit: 3, total: 7, totalPages: 3 });
    });

    it('limit=5 (the bell) works; totalPages = ceil(total / limit)', async () => {
      const body = await list(ADMIN_X, `?search=${TOKEN}&limit=5`);
      expect(body.data).toHaveLength(5);
      expect(body.meta.totalPages).toBe(2);
    });

    it('defaults to page 1, limit 10', async () => {
      const body = await list(ADMIN_X, `?search=${TOKEN}`);
      expect(body.meta).toMatchObject({ page: 1, limit: 10 });
    });

    it('an empty result has totalPages 0', async () => {
      const body = await list(ADMIN_X, '?search=zqnotifnothingmatches');
      expect(body.meta).toEqual({
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 0,
      });
    });

    it.each([['limit=0'], ['limit=51'], ['page=0'], ['limit=abc']])(
      '?%s → 400',
      async (qs) => {
        await as(ADMIN_X)
          .agent.get(url(`/notifications?${qs}`))
          .expect(400);
      },
    );
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-11 — idempotency
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-11 — idempotent read / unread', () => {
    const TOKEN = 'zqnotifidem';
    let one = '';
    let two = '';

    beforeAll(async () => {
      one = await seed({ token: TOKEN });
      two = await seed({ token: TOKEN });
    });

    it('E-3 twice → 200 both times, and readAt does not move', async () => {
      const first = (await patchState(ADMIN_X, one, 'read').expect(200))
        .body as Item;
      expect(first.isRead).toBe(true);
      const stored = (await receipt(ADMIN_X, one))?.readAt;

      const second = (await patchState(ADMIN_X, one, 'read').expect(200))
        .body as Item;
      expect(second.readAt).toBe(first.readAt);
      expect((await receipt(ADMIN_X, one))?.readAt).toEqual(stored);
    });

    it('E-4 on an unread item → 200 no-op, and creates no receipt row', async () => {
      const res = (await patchState(ADMIN_X, two, 'unread').expect(200))
        .body as Item;
      expect(res).toMatchObject({ id: two, isRead: false, readAt: null });
      expect(await receipt(ADMIN_X, two)).toBeNull();
    });

    it('E-4 on a read item → unread; repeating it is a no-op', async () => {
      const res = (await patchState(ADMIN_X, one, 'unread').expect(200))
        .body as Item;
      expect(res).toMatchObject({ isRead: false, readAt: null });
      await patchState(ADMIN_X, one, 'unread').expect(200);
      expect((await receipt(ADMIN_X, one))?.readAt).toBeNull();
    });

    it('the notification row itself is never written by read/unread', async () => {
      const before = await prisma.adminNotification.findUnique({
        where: { id: one },
        select: { updatedAt: true },
      });
      await patchState(ADMIN_X, one, 'read').expect(200);
      await patchState(ADMIN_X, one, 'unread').expect(200);
      expect(
        await prisma.adminNotification.findUnique({
          where: { id: one },
          select: { updatedAt: true },
        }),
      ).toEqual(before);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-12 — read-all
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-12 — read-all (E-5)', () => {
    const TOKEN = 'zqnotifrall';
    const f = { r1: '', r2: '', r3: '', superOnly: '' };

    beforeAll(async () => {
      f.r1 = await seed({ token: TOKEN, category: BOOKING });
      f.r2 = await seed({ token: TOKEN, category: SYSTEM });
      f.r3 = await seed({ token: TOKEN, category: FEEDBACK });
      f.superOnly = await seed({ token: TOKEN, targetRole: SUPER_ADMIN });
    });

    it('with ids: only those change; a repeat counts 0', async () => {
      await readAll(READER, { ids: [f.r1] })
        .expect(200)
        .expect({ updated: 1 });
      await readAll(READER, { ids: [f.r1] })
        .expect(200)
        .expect({ updated: 0 });
      expect((await receipt(READER, f.r1))?.readAt).toBeInstanceOf(Date);
      expect(await receipt(READER, f.r2)).toBeNull();
    });

    it('no body: marks EVERY visible unread row, returns the exact changed count, touches nobody else', async () => {
      const readerBefore = await unread(READER);
      const otherBefore = await unread(ADMIN_Y);
      expect(readerBefore.total).toBeGreaterThanOrEqual(2);

      const res = await readAll(READER).expect(200);
      expect(res.body).toEqual({ updated: readerBefore.total });

      expect((await unread(READER)).total).toBe(0);
      expect(await unread(ADMIN_Y)).toEqual(otherBefore);
      expect(await receipt(ADMIN_Y, f.r2)).toBeNull();
      // Role visibility holds on the unbounded path too.
      expect(await receipt(READER, f.superOnly)).toBeNull();
    });

    it('`{}` means "all" as well; nothing left → {updated:0}', async () => {
      await readAll(READER, {}).expect(200).expect({ updated: 0 });
      await readAll(READER).expect(200).expect({ updated: 0 });
    });

    it('after read-all, the caller’s list shows the fixtures read; another operator’s does not', async () => {
      expect(
        (await search(READER, TOKEN)).data.every((item) => item.isRead),
      ).toBe(true);
      expect(
        (await search(ADMIN_Y, TOKEN)).data.some((item) => item.isRead),
      ).toBe(false);
    });

    it('read-all never resurrects a DISMISSED row', async () => {
      const id = await seed({ token: TOKEN });
      await bulk(READER, { ids: [id] })
        .expect(200)
        .expect({ deleted: 1 });
      await readAll(READER).expect(200).expect({ updated: 0 });
      await readAll(READER, { ids: [id] })
        .expect(200)
        .expect({ updated: 0 });
      expect(await receipt(READER, id)).toEqual({
        readAt: null,
        dismissedAt: expect.any(Date) as Date,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-13 / AC-16 — dismissal ("delete for me"), never a hard delete
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-13 / AC-16 — dismiss (E-6)', () => {
    const TOKEN = 'zqnotifdism';
    const f = { d1: '', d2: '', d3: '', d4: '', superOnly: '' };

    beforeAll(async () => {
      f.d1 = await seed({ token: TOKEN, category: BOOKING });
      f.d2 = await seed({ token: TOKEN, category: SYSTEM });
      f.d3 = await seed({ token: TOKEN, category: BOOKING });
      f.d4 = await seed({
        token: TOKEN,
        targetRole: ADMIN,
        category: FEEDBACK,
      });
      f.superOnly = await seed({ token: TOKEN, targetRole: SUPER_ADMIN });
    });

    it('{ids}: gone from the caller’s list and count, still there for another operator of the same role', async () => {
      const xBefore = await unread(ADMIN_X);
      const yBefore = await unread(ADMIN_Y);

      await bulk(ADMIN_X, { ids: [f.d1] })
        .expect(200)
        .expect({ deleted: 1 });

      expect(idsOf(await search(ADMIN_X, TOKEN))).not.toContain(f.d1);
      expect(idsOf(await search(ADMIN_Y, TOKEN))).toContain(f.d1);
      const xAfter = await unread(ADMIN_X);
      expect(xAfter.total).toBe(xBefore.total - 1);
      expect(xAfter.byCategory.BOOKING).toBe(xBefore.byCategory.BOOKING - 1);
      expect(await unread(ADMIN_Y)).toEqual(yBefore);
    });

    it('AC-16: the notification row still exists — nothing is hard-deleted', async () => {
      expect(
        await prisma.adminNotification.findUnique({
          where: { id: f.d1 },
          select: { id: true },
        }),
      ).toEqual({ id: f.d1 });
    });

    it('a dismissed id is then 404 on E-3/E-4 (no resurrection), and 0 on a repeat', async () => {
      await patchState(ADMIN_X, f.d1, 'read').expect(404);
      await patchState(ADMIN_X, f.d1, 'unread').expect(404);
      await bulk(ADMIN_X, { ids: [f.d1] })
        .expect(200)
        .expect({ deleted: 0 });
      expect(await receipt(ADMIN_X, f.d1)).toEqual({
        readAt: null,
        dismissedAt: expect.any(Date) as Date,
      });
    });

    it('mixed visible + invisible ids: only the visible one counts', async () => {
      await bulk(ADMIN_X, { ids: [f.d2, f.superOnly, GHOST_ID] })
        .expect(200)
        .expect({ deleted: 1 });
      expect(await receipt(ADMIN_X, f.superOnly)).toBeNull();
    });

    it('a READ item can be dismissed by id (the receipt is stamped, not duplicated)', async () => {
      await patchState(ADMIN_Y, f.d3, 'read').expect(200);
      await bulk(ADMIN_Y, { ids: [f.d3] })
        .expect(200)
        .expect({ deleted: 1 });
      const r = await receipt(ADMIN_Y, f.d3);
      expect(r?.readAt).toBeInstanceOf(Date);
      expect(r?.dismissedAt).toBeInstanceOf(Date);
    });

    it('{allRead:true}: dismisses ONLY read items, across categories, ignoring list filters', async () => {
      // DISMISSER exists only for this: its read set is exactly these two, in two categories.
      await patchState(DISMISSER, f.d3, 'read').expect(200);
      await patchState(DISMISSER, f.d4, 'read').expect(200);
      const countBefore = await unread(DISMISSER);

      await bulk(DISMISSER, { allRead: true })
        .expect(200)
        .expect({ deleted: 2 });

      const left = idsOf(await search(DISMISSER, TOKEN));
      expect(left).toEqual(expect.arrayContaining([f.d1, f.d2]));
      expect(left).not.toContain(f.d3);
      expect(left).not.toContain(f.d4);
      // Unread items were not touched, so the unread count is unchanged.
      expect(await unread(DISMISSER)).toEqual(countBefore);
      expect(await receipt(DISMISSER, f.d1)).toBeNull();
      await bulk(DISMISSER, { allRead: true })
        .expect(200)
        .expect({ deleted: 0 });
      for (const id of [f.d3, f.d4]) {
        expect(
          await prisma.adminNotification.findUnique({
            where: { id },
            select: { id: true },
          }),
        ).toEqual({ id });
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-14 — body validation
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-14 — body validation', () => {
    const TOKEN = 'zqnotifbody';
    let target = '';

    beforeAll(async () => {
      target = await seed({ token: TOKEN });
    });

    const fiftyOne = () =>
      Array.from({ length: 51 }, (_, i) => cuidLike(i + 1));

    it.each([
      ['both keys', () => ({ ids: [target], allRead: true })],
      ['neither key ({})', () => ({})],
    ])(
      'E-6 %s → 400 with the one exactly-one message, nothing written',
      async (_label, body) => {
        const res = await bulk(ADMIN_X, body()).expect(400);
        expect((res.body as { message: string }).message).toBe(
          NOTIFICATION_DISMISS_TARGET,
        );
        expect(await receipt(ADMIN_X, target)).toBeNull();
      },
    );

    it('E-6 with NO body → the same 400', async () => {
      const res = await bulk(ADMIN_X).expect(400);
      expect((res.body as { message: string }).message).toBe(
        NOTIFICATION_DISMISS_TARGET,
      );
    });

    it.each([
      ['allRead: false', () => ({ allRead: false })],
      ['allRead: "true"', () => ({ allRead: 'true' })],
      ['allRead: null', () => ({ allRead: null })],
      ['ids: []', () => ({ ids: [] })],
      ['51 ids', () => ({ ids: fiftyOne() })],
      ['a duplicate id', () => ({ ids: [target, target] })],
      ['a non-cuid', () => ({ ids: ['not-a-cuid'] })],
      ['ids: null', () => ({ ids: null })],
      ['systemUserId', () => ({ ids: [target], systemUserId: target })],
      ['dismissedAt', () => ({ ids: [target], dismissedAt: '2026-01-01' })],
    ])('E-6 %s → 400, nothing written', async (_label, body) => {
      await bulk(ADMIN_X, body()).expect(400);
      expect(await receipt(ADMIN_X, target)).toBeNull();
    });

    it.each([
      ['ids: []', () => ({ ids: [] })],
      ['51 ids', () => ({ ids: fiftyOne() })],
      ['a duplicate id', () => ({ ids: [target, target] })],
      ['a non-cuid', () => ({ ids: ['seed_notif_01'] })],
      ['ids: null (never read as "all")', () => ({ ids: null })],
      ['systemUserId', () => ({ systemUserId: target })],
      ['readAt', () => ({ ids: [target], readAt: '2026-01-01' })],
    ])('E-5 %s → 400, nothing written', async (_label, body) => {
      await readAll(ADMIN_X, body()).expect(400);
      expect(await receipt(ADMIN_X, target)).toBeNull();
    });

    it('E-3 has no body DTO: a body naming another operator is never read — the write lands on the SESSION user', async () => {
      const res = await patchState(ADMIN_X, target, 'read')
        .send({ systemUserId: userIds[ADMIN_Y] })
        .expect(200);
      expect((res.body as Item).isRead).toBe(true);
      // The write landed on the SESSION user, never the body's id.
      expect(await receipt(ADMIN_Y, target)).toBeNull();
      await patchState(ADMIN_X, target, 'unread').expect(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-15 — VIEWER may write its OWN state
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-15 — VIEWER on all six routes', () => {
    const TOKEN = 'zqnotifviewer';
    const f = { v1: '', v2: '' };

    beforeAll(async () => {
      f.v1 = await seed({ token: TOKEN, targetRole: ALL });
      f.v2 = await seed({ token: TOKEN, targetRole: ALL });
    });

    it('E-1…E-6 all answer 2xx for a VIEWER on ALL items, and never write a notification row', async () => {
      const rowsBefore = await prisma.adminNotification.findMany({
        where: { id: { in: [f.v1, f.v2] } },
        select: { id: true, updatedAt: true },
        orderBy: { id: 'asc' },
      });

      expect(idsOf(await search(VIEWER, TOKEN)).sort()).toEqual(
        [f.v1, f.v2].sort(),
      );
      await unread(VIEWER);
      expect(
        ((await patchState(VIEWER, f.v1, 'read').expect(200)).body as Item)
          .isRead,
      ).toBe(true);
      expect(
        ((await patchState(VIEWER, f.v1, 'unread').expect(200)).body as Item)
          .isRead,
      ).toBe(false);
      await readAll(VIEWER, { ids: [f.v1] })
        .expect(200)
        .expect({ updated: 1 });
      await bulk(VIEWER, { ids: [f.v2] })
        .expect(200)
        .expect({ deleted: 1 });
      const all = await bulk(VIEWER, { allRead: true }).expect(200);
      expect((all.body as { deleted: number }).deleted).toBeGreaterThanOrEqual(
        1,
      );

      expect(idsOf(await search(VIEWER, TOKEN))).toEqual([]);
      // Still there — and untouched — for everybody else.
      expect(idsOf(await search(ADMIN_Y, TOKEN)).sort()).toEqual(
        [f.v1, f.v2].sort(),
      );
      expect(
        await prisma.adminNotification.findMany({
          where: { id: { in: [f.v1, f.v2] } },
          select: { id: true, updatedAt: true },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(rowsBefore);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-17 — no creation route; the service-level create()
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-17 — create() is service-only', () => {
    it('POST /notifications is not a route (404) — nobody can forge an alert', async () => {
      await as(SUPER)
        .agent.post(url('/notifications'))
        .set('x-csrf-token', as(SUPER).token)
        .send({
          category: SYSTEM,
          title: 'forged',
          body: 'forged',
          tone: 'ROSE',
          icon: 'bug-ant',
        })
        .expect(404);
    });

    it('create() persists the row with the given fields and defaults targetRole to ALL', async () => {
      const service = app.get(NotificationsService);
      const row = await service.create({
        category: REGISTRATION,
        tone: AdminNotificationTone.AMBER,
        icon: 'user-plus',
        title: '  zqnotifcreate ผู้ใช้ลงทะเบียนใหม่  ',
        body: 'สมชาย ใจดี · ครู',
        code: `${CODE_PREFIX}create-0001`,
        actionUrl: '/backend/line-users',
        actionLabel: 'ตรวจสอบข้อมูล',
      });
      expect(row).toMatchObject({
        category: REGISTRATION,
        targetRole: ALL,
        title: 'zqnotifcreate ผู้ใช้ลงทะเบียนใหม่',
        actionUrl: '/backend/line-users',
        actionLabel: 'ตรวจสอบข้อมูล',
      });
      expect(
        await prisma.adminNotification.findUnique({ where: { id: row.id } }),
      ).toMatchObject({ id: row.id, targetRole: ALL, icon: 'user-plus' });
      // Visible to every role, unread for all, with no receipt rows created.
      expect(idsOf(await search(VIEWER, 'zqnotifcreate'))).toEqual([row.id]);
      expect(
        await prisma.adminNotificationReceipt.count({
          where: { notificationId: row.id },
        }),
      ).toBe(0);
    });

    it('create() rejects an actionUrl outside /backend/ and writes nothing', async () => {
      const service = app.get(NotificationsService);
      await expect(
        service.create({
          category: SYSTEM,
          tone: AdminNotificationTone.ROSE,
          icon: 'link-slash',
          title: 'zqnotifcreate bad link',
          body: 'x',
          code: `${CODE_PREFIX}create-0002`,
          actionUrl: 'https://evil.example/backend/',
          actionLabel: 'ไปที่หน้าตั้งค่า',
        }),
      ).rejects.toThrow(/actionUrl/);
      expect(
        await prisma.adminNotification.count({
          where: { code: `${CODE_PREFIX}create-0002` },
        }),
      ).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-18 — literal routes are never parsed as :id
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-18 — route ordering', () => {
    it('GET /notifications/unread-count reaches its own handler (the count shape)', async () => {
      const body = await unread(ADMIN_X);
      expect(body).toEqual({
        total: expect.any(Number) as number,
        byCategory: {
          BOOKING: expect.any(Number) as number,
          REGISTRATION: expect.any(Number) as number,
          FEEDBACK: expect.any(Number) as number,
          SYSTEM: expect.any(Number) as number,
        },
      });
    });

    it('POST /notifications/read-all reaches its own handler ({updated})', async () => {
      const res = await readAll(ADMIN_X, { ids: [GHOST_ID] }).expect(200);
      expect(res.body).toEqual({ updated: 0 });
    });

    it('DELETE /notifications/bulk reaches its own handler (its exactly-one 400)', async () => {
      const res = await bulk(ADMIN_X, {}).expect(400);
      expect((res.body as { message: string }).message).toBe(
        NOTIFICATION_DISMISS_TARGET,
      );
    });

    it('a literal segment in the :id slot is just a 404 id (never a 400)', async () => {
      for (const id of ['unread-count', 'read-all', 'bulk']) {
        await patchState(ADMIN_X, id, 'read').expect(404);
      }
    });

    it('there is no single-segment GET/DELETE :id route', async () => {
      const id = await seed({ token: 'zqnotifroute' });
      await as(ADMIN_X)
        .agent.get(url(`/notifications/${id}`))
        .expect(404);
      await as(ADMIN_X)
        .agent.delete(url(`/notifications/${id}`))
        .set('x-csrf-token', as(ADMIN_X).token)
        .expect(404);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-19 — the OpenAPI contract Phase 2 generates from
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-19 — /docs-json', () => {
    type Schema = {
      $ref?: string;
      enum?: unknown[];
      type?: string;
      maximum?: number;
    };
    type Operation = {
      operationId?: string;
      tags?: string[];
      responses: Record<string, unknown>;
      parameters?: Array<{ name: string; in: string; schema?: Schema }>;
      requestBody?: {
        required?: boolean;
        content: Record<string, { schema: Schema }>;
      };
    };
    type Doc = {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, Schema> };
    };
    let doc: Doc;
    const p = (path: string) =>
      doc.paths[`${API_BASE_PATH}/notifications${path}`];

    beforeAll(() => {
      // `createE2eApp` does not mount Swagger (main.ts does), so build the same document here.
      doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      ) as unknown as Doc;
    });

    it('🔴 DELETE /notifications/bulk carries a REQUIRED JSON request body (S-5 regression guard)', () => {
      const body = p('/bulk').delete.requestBody;
      expect(body?.required).toBe(true);
      expect(body?.content['application/json'].schema.$ref).toMatch(
        /DismissAdminNotificationsDto$/,
      );
    });

    it('POST /notifications/read-all carries an OPTIONAL body', () => {
      const body = p('/read-all').post.requestBody;
      expect(body?.required).toBe(false);
      expect(body?.content['application/json'].schema.$ref).toMatch(
        /MarkAdminNotificationsReadDto$/,
      );
    });

    it('exposes exactly the six operations, tagged, with their success and error codes', () => {
      const ops: Array<[Operation, string, string[]]> = [
        [p('').get, 'NotificationsController_list', ['200', '400', '401']],
        [
          p('/unread-count').get,
          'NotificationsController_unreadCount',
          ['200', '401'],
        ],
        [
          p('/read-all').post,
          'NotificationsController_markManyRead',
          ['200', '400', '401', '403'],
        ],
        [
          p('/bulk').delete,
          'NotificationsController_dismiss',
          ['200', '400', '401', '403'],
        ],
        [
          p('/{id}/read').patch,
          'NotificationsController_markRead',
          ['200', '401', '403', '404'],
        ],
        [
          p('/{id}/unread').patch,
          'NotificationsController_markUnread',
          ['200', '401', '403', '404'],
        ],
      ];
      for (const [op, operationId, codes] of ops) {
        expect(op.operationId).toBe(operationId);
        expect(op.tags).toEqual(['Notifications']);
        expect(Object.keys(op.responses)).toEqual(
          expect.arrayContaining(codes),
        );
        // POST/DELETE here answer 200, never Nest's default 201/204.
        expect(Object.keys(op.responses)).not.toContain('201');
        expect(Object.keys(op.responses)).not.toContain('204');
      }
      expect(p('').post).toBeUndefined();
      const notifPaths = Object.keys(doc.paths).filter((k) =>
        k.startsWith(`${API_BASE_PATH}/notifications`),
      );
      expect(notifPaths.sort()).toEqual(
        [
          '',
          '/unread-count',
          '/read-all',
          '/bulk',
          '/{id}/read',
          '/{id}/unread',
        ]
          .map((s) => `${API_BASE_PATH}/notifications${s}`)
          .sort(),
      );
    });

    it('publishes the enums under their own names', () => {
      const s = doc.components.schemas;
      expect(s.AdminNotificationCategory?.enum).toEqual([
        'BOOKING',
        'REGISTRATION',
        'FEEDBACK',
        'SYSTEM',
      ]);
      expect(s.AdminNotificationTone?.enum).toEqual([
        'SKY',
        'AMBER',
        'ROSE',
        'EMERALD',
        'SLATE',
      ]);
      expect(s.AdminNotificationTargetRole?.enum).toEqual([
        'ALL',
        'ADMIN',
        'SUPER_ADMIN',
      ]);
      expect(s.AdminNotificationIcon?.enum).toEqual([
        ...ADMIN_NOTIFICATION_ICONS,
      ]);
      expect(s.AdminNotificationPeriod?.enum).toEqual(['today', '7d', '30d']);
    });

    it('publishes the request and response schemas', () => {
      for (const name of [
        'AdminNotificationDto',
        'PaginatedAdminNotificationsResponseDto',
        'AdminNotificationUnreadCountDto',
        'AdminNotificationUnreadByCategoryDto',
        'AdminNotificationsUpdatedDto',
        'AdminNotificationsDismissedDto',
        'MarkAdminNotificationsReadDto',
        'DismissAdminNotificationsDto',
      ]) {
        expect(doc.components.schemas).toHaveProperty(name);
      }
      // Referenced, never redeclared.
      expect(doc.components.schemas).not.toHaveProperty('PaginationMetaDto1');
    });

    it('types the list query: isRead boolean, limit 1–50, the category enum', () => {
      const params = p('').get.parameters ?? [];
      const byName = (n: string) => params.find((x) => x.name === n);
      expect(byName('isRead')?.schema?.type).toBe('boolean');
      expect(byName('limit')?.schema?.maximum).toBe(50);
      expect(JSON.stringify(byName('category'))).toContain(
        'AdminNotificationCategory',
      );
      expect(byName('search')).toBeDefined();
      expect(byName('period')).toBeDefined();
      expect(byName('page')).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-20 — the dev database is left exactly as found. MUST STAY THE LAST BLOCK.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-20 — dev-DB safety', () => {
    it('no pre-existing notification and no non-e2e operator’s receipt was modified or deleted', async () => {
      const now = await snapshotForeign();
      expect(now.notifications).toEqual(foreignNotifications);
      expect(now.receipts).toEqual(foreignReceipts);
    });

    it('cleanup by prefix leaves no e2e-notif- notification and no e2e operator receipt', async () => {
      await purgeFixtures();
      const e2eIds = Object.values(userIds);
      // Receipts on NON-fixture rows (seed/real) belong to e2e operators; the user purge cascades them.
      await purgeE2eUsers(prisma, SU_PREFIX);
      expect(
        await prisma.adminNotification.count({
          where: { code: { startsWith: CODE_PREFIX } },
        }),
      ).toBe(0);
      expect(
        await prisma.adminNotificationReceipt.count({
          where: { systemUserId: { in: e2eIds } },
        }),
      ).toBe(0);
      expect(await snapshotForeign()).toEqual({
        notifications: foreignNotifications,
        receipts: foreignReceipts,
      });
    });
  });
});
