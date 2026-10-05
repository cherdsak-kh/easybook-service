import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { LoginEventStatus, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { loginIpEmailKey, loginIpKey } from '../src/auth/login-throttle.key';
import { SessionTrackerService } from '../src/auth/sessions/session-tracker.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  SESSION_INDEX_KEY_PREFIX,
  SESSION_KEY_PREFIX,
  sessionIndexKey,
} from '../src/redis/redis.constants';
import {
  cookieValue,
  createE2eApp,
  ensureE2eOptions,
  prismaOf,
  purgeE2eUsers,
  readCookie,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(120_000);

/**
 * LOGIN-SESSIONS-1 — login history and session revocation, end to end.
 *
 * ⚠️ This suite runs against the DEV database and the DEV Redis. It therefore:
 *  - creates only `e2e-sess-` users and removes them (the `Cascade` FK takes their login rows with them);
 *  - deletes Redis keys ONLY by exact name — never `KEYS`, `SCAN` or a flush. Sessions are removed through
 *    each fixture user's own index Set; throttle counters through `loginIpKey` / `loginIpEmailKey`;
 *  - seeds the −91-day rows with explicit ids and deletes them by those ids.
 */

const PREFIX = 'e2e-sess-';
const PASSWORD = 'E2e-correct-horse-battery-1';
const EMAILS = {
  SA1: `${PREFIX}sa1@easybook.local`,
  SA2: `${PREFIX}sa2@easybook.local`,
  ADMIN: `${PREFIX}admin@easybook.local`,
  VIEWER: `${PREFIX}viewer@easybook.local`,
  TARGET: `${PREFIX}target@easybook.local`,
  SUSPENDED: `${PREFIX}suspended@easybook.local`,
  GATED: `${PREFIX}gated@easybook.local`,
} as const;
const NOBODY = `${PREFIX}nobody@easybook.local`;
type Who = keyof typeof EMAILS;

/** The socket peer under supertest — `configureApp` sets no `trust proxy`, so `resolveIp` yields this. */
const LOOPBACK = ['::ffff:127.0.0.1', '127.0.0.1', '::1'];

const UA_CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_LINE_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.9.0';
const UA_FIREFOX_LINUX =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0';

const DAY_MS = 24 * 60 * 60 * 1000;
const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Device {
  deviceType: string;
  os: string | null;
  osVersion: string | null;
  browser: string | null;
  browserVersion: string | null;
}
interface SessionItem {
  handle: string;
  isCurrent: boolean;
  device: Device;
  ipAddress: string | null;
  loginAt: string;
  lastActiveAt: string;
}
interface SessionList {
  current: SessionItem;
  others: SessionItem[];
}
interface HistoryPage {
  data: Array<{
    id: string;
    status: LoginEventStatus;
    createdAt: string;
    device: Device | null;
    ipAddress: string | null;
    isCurrentSession: boolean;
  }>;
  meta: { page: number; limit: number; total: number; totalPages: number };
}
interface Summary {
  activeSessionCount: number;
  lastLogin: {
    at: string;
    device: Device | null;
    ipAddress: string | null;
  } | null;
  lastForceRevokedAt: string | null;
}

/** A signed-in device: one cookie jar, one CSRF token, one fixed User-Agent. */
interface Device_ {
  agent: request.Agent;
  token: string;
  sid: string;
  handle: string;
}

/** `eb.sid` is a signed cookie: `s:<sid>.<hmac>`. The Redis key uses the bare `<sid>`. */
const sidOf = (cookie: string | undefined): string => {
  const value = decodeURIComponent(cookieValue(cookie) ?? '');
  return value.startsWith('s:')
    ? value.slice(2, value.lastIndexOf('.'))
    : value;
};

describe('Login history & session revocation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let tracker: SessionTrackerService;
  const ids = {} as Record<Who, string>;
  const seededLogIds: string[] = [];

  const server = () => app.getHttpServer();

  // ───────────────────────────── helpers ─────────────────────────────

  const csrfFor = async (agent: request.Agent): Promise<string> => {
    const res = await agent.get(url('/auth/system/csrf')).expect(200);
    return (res.body as { csrfToken: string }).csrfToken;
  };

  /** Logs `who` in on a fresh device. */
  const signIn = async (
    who: Who,
    userAgent: string = UA_FIREFOX_LINUX,
  ): Promise<Device_> => {
    const agent = request.agent(server()).set('User-Agent', userAgent);
    const token = await csrfFor(agent);
    const res = await agent
      .post(url('/auth/system/login'))
      .set('x-csrf-token', token)
      .send({ email: EMAILS[who], password: PASSWORD })
      .expect(200);
    const sid = sidOf(readCookie(res, 'eb.sid'));
    return { agent, token, sid, handle: tracker.handleOf(sid) };
  };

  const listOf = async (d: Device_): Promise<SessionList> =>
    (await d.agent.get(url('/auth/system/sessions')).expect(200))
      .body as SessionList;

  const me = (d: Device_) => d.agent.get(url('/auth/system/me'));

  const setActive = (who: Who, isActive: boolean) =>
    prisma.systemUser.update({
      where: { id: ids[who] },
      data: { isActive },
      select: { id: true },
    });

  const members = (who: Who) => redis.smembers(sessionIndexKey(ids[who]));

  const countRows = (who: Who, status: LoginEventStatus) =>
    prisma.systemUserLoginLog.count({
      where: { systemUserId: ids[who], status },
    });

  /** The failed-login and success rows are written after the response (fire-and-forget): poll briefly. */
  const waitForRows = async (
    who: Who,
    status: LoginEventStatus,
    expected: number,
    timeoutMs = 2_000,
  ): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    let n = await countRows(who, status);
    while (n < expected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      n = await countRows(who, status);
    }
    return n;
  };

  const bangkokToday = () =>
    new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

  /** The activity report for today's window, minus its own `serverTime` stamp. */
  const activitySnapshot = async (d: Device_) => {
    const day = bangkokToday();
    const body = (
      await d.agent
        .get(url(`/reports/activity?startDate=${day}&endDate=${day}&limit=50`))
        .expect(200)
    ).body as Record<string, unknown>;
    delete body.serverTime;
    return body;
  };

  /** Exact-key cleanup — no KEYS, no SCAN, no flush. */
  const cleanRedis = async () => {
    for (const who of Object.keys(EMAILS) as Who[]) {
      if (!ids[who]) continue;
      const sids = await redis.smembers(sessionIndexKey(ids[who]));
      for (const sid of sids) await redis.del(`${SESSION_KEY_PREFIX}${sid}`);
      await redis.del(sessionIndexKey(ids[who]));
    }
  };

  /** Exact throttle keys for the loopback addresses and every fixture email. */
  const clearOwnThrottle = async () => {
    const keys: string[] = [];
    for (const ip of LOOPBACK) {
      keys.push(loginIpKey(ip));
      for (const email of [...Object.values(EMAILS), NOBODY]) {
        keys.push(loginIpEmailKey(ip, email));
      }
    }
    await redis.del(...keys);
  };

  const seed = async () => {
    const passwordHash = await new PasswordService().hash(PASSWORD);
    const options = await ensureE2eOptions(prisma);
    const base = { passwordHash, mustChangePassword: false, ...options };
    const defs: Array<[Who, SystemRole, Record<string, unknown>]> = [
      ['SA1', SystemRole.SUPER_ADMIN, {}],
      ['SA2', SystemRole.SUPER_ADMIN, {}],
      ['ADMIN', SystemRole.ADMIN, {}],
      ['VIEWER', SystemRole.VIEWER, {}],
      ['TARGET', SystemRole.VIEWER, {}],
      ['SUSPENDED', SystemRole.VIEWER, { isActive: false }],
      ['GATED', SystemRole.VIEWER, { mustChangePassword: true }],
    ];
    for (const [who, role, extra] of defs) {
      const row = await prisma.systemUser.create({
        data: {
          email: EMAILS[who],
          firstName: 'E2E',
          lastName: who,
          role,
          ...base,
          ...extra,
        },
        select: { id: true },
      });
      ids[who] = row.id;
    }
  };

  // ───────────────────────────── lifecycle ─────────────────────────────

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    tracker = app.get(SessionTrackerService);
    await waitForRedis(redis);
    await purgeE2eUsers(prisma, PREFIX);
    await seed();
  });

  beforeEach(async () => {
    await clearOwnThrottle();
  });

  afterEach(async () => {
    await cleanRedis();
    await clearOwnThrottle();
    // Restore anything a test flipped, and drop the fixtures' own login rows (by exact fixture id).
    await prisma.systemUser.updateMany({
      where: { id: { in: [ids.TARGET, ids.VIEWER] } },
      data: { isActive: true, deletedAt: null },
    });
    await prisma.systemUserLoginLog.deleteMany({
      where: { systemUserId: { in: Object.values(ids) } },
    });
    if (seededLogIds.length > 0) {
      await prisma.systemUserLoginLog.deleteMany({
        where: { id: { in: seededLogIds.splice(0) } },
      });
    }
  });

  afterAll(async () => {
    await cleanRedis();
    await purgeE2eUsers(prisma, PREFIX);
    await app.close();
  });

  // ───────────────────────────── AC-1 .. AC-4 ─────────────────────────────

  describe('indexing (AC-1, AC-2, AC-3)', () => {
    it('AC-1 — a login indexes exactly one sid, the key exists, the index TTL is >= 24 h, and the family is disjoint', async () => {
      const a = await signIn('VIEWER', UA_CHROME_WIN);

      expect(await redis.sismember(sessionIndexKey(ids.VIEWER), a.sid)).toBe(1);
      expect(await members('VIEWER')).toEqual([a.sid]);
      expect(await redis.exists(`${SESSION_KEY_PREFIX}${a.sid}`)).toBe(1);

      const ttl = await redis.ttl(sessionIndexKey(ids.VIEWER));
      expect(ttl).toBeGreaterThanOrEqual(86_400);
      expect(ttl).toBeLessThanOrEqual(86_460);

      expect(SESSION_INDEX_KEY_PREFIX.startsWith('eb:sess:')).toBe(false);
      expect(SESSION_INDEX_KEY_PREFIX.startsWith('eb:cache:')).toBe(false);

      // The descriptive metadata rides inside the session JSON itself.
      const stored = JSON.parse(
        (await redis.get(`${SESSION_KEY_PREFIX}${a.sid}`)) ?? '{}',
      ) as { ip?: string; userAgent?: string; systemUserId?: string };
      expect(stored.systemUserId).toBe(ids.VIEWER);
      expect(stored.userAgent).toBe(UA_CHROME_WIN);
      // Fails loudly (instead of 429-ing mysteriously) if a different environment sees another peer address.
      expect(LOOPBACK).toContain(stored.ip);
    });

    it('AC-2 — a key deleted out of band disappears from the next list AND from the Set', async () => {
      const a = await signIn('VIEWER');
      const b = await signIn('VIEWER');
      expect((await listOf(a)).others).toHaveLength(1);

      await redis.del(`${SESSION_KEY_PREFIX}${b.sid}`);

      expect((await listOf(a)).others).toEqual([]);
      expect(await redis.sismember(sessionIndexKey(ids.VIEWER), b.sid)).toBe(0);
    });

    it('AC-3 — logout removes the sid; a guard-destroyed session (suspension) never reappears in E1 or E5', async () => {
      const first = await signIn('TARGET');
      await first.agent
        .post(url('/auth/system/logout'))
        .set('x-csrf-token', first.token)
        .expect(200);
      expect(
        await redis.sismember(sessionIndexKey(ids.TARGET), first.sid),
      ).toBe(0);

      const t1 = await signIn('TARGET');
      const t2 = await signIn('TARGET');
      await setActive('TARGET', false);
      await me(t1).expect(401);
      await me(t2).expect(401);
      await setActive('TARGET', true);

      const t3 = await signIn('TARGET');
      expect((await listOf(t3)).others).toEqual([]);

      const sa = await signIn('SA1');
      const summary = (
        await sa.agent
          .get(url(`/system-users/${ids.TARGET}/sessions`))
          .expect(200)
      ).body as Summary;
      expect(summary.activeSessionCount).toBe(1);
    });
  });

  // ───────────────────────────── AC-5 .. AC-10 ─────────────────────────────

  describe('list and revoke your own sessions', () => {
    it('AC-5 — three devices: current + two others, each with parsed device, ip, loginAt and lastActiveAt', async () => {
      const a = await signIn('VIEWER', UA_CHROME_WIN);
      await signIn('VIEWER', UA_IPAD);
      await signIn('VIEWER', UA_LINE_IPHONE);

      const res = await listOf(a);

      expect(res.current).toMatchObject({
        isCurrent: true,
        handle: a.handle,
        device: { deviceType: 'desktop', os: 'Windows', browser: 'Chrome' },
      });
      expect(LOOPBACK).toContain(res.current.ipAddress);
      expect(res.others).toHaveLength(2);
      const labels = res.others.map(
        (o) => `${o.device.deviceType}/${o.device.os}/${o.device.browser}`,
      );
      expect(labels.sort()).toEqual(
        ['phone/iOS/LINE', 'tablet/iPadOS/Safari'].sort(),
      );
      for (const o of res.others) {
        expect(o.isCurrent).toBe(false);
        expect(o.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(Number.isNaN(Date.parse(o.loginAt))).toBe(false);
        expect(Date.parse(o.lastActiveAt)).toBeGreaterThanOrEqual(
          Date.parse(o.loginAt),
        );
      }
      // lastActiveAt DESC.
      expect(Date.parse(res.others[0].lastActiveAt)).toBeGreaterThanOrEqual(
        Date.parse(res.others[1].lastActiveAt),
      );
    });

    it("AC-6 — revoking B: 200, B gets 401, A and C keep working, and B's handle is then a 404", async () => {
      const a = await signIn('VIEWER');
      const b = await signIn('VIEWER');
      const c = await signIn('VIEWER');

      const res = await a.agent
        .delete(url(`/auth/system/sessions/${b.handle}`))
        .set('x-csrf-token', a.token)
        .expect(200);
      expect(res.body).toEqual({ revoked: 1 });

      await me(b).expect(401);
      await me(a).expect(200);
      await me(c).expect(200);

      await a.agent
        .delete(url(`/auth/system/sessions/${b.handle}`))
        .set('x-csrf-token', a.token)
        .expect(404);
    });

    it('AC-7 — a foreign, unknown and malformed handle are ONE byte-identical 404; the own handle is 400; no CSRF is 403', async () => {
      const viewer = await signIn('VIEWER');
      const admin = await signIn('ADMIN');

      const attempt = (handle: string) =>
        viewer.agent
          .delete(url(`/auth/system/sessions/${handle}`))
          .set('x-csrf-token', viewer.token);

      const foreign = await attempt(admin.handle).expect(404);
      const unknown = await attempt('A'.repeat(22)).expect(404);
      const malformed = await attempt('abc').expect(404);
      expect(foreign.text).toBe(unknown.text);
      expect(malformed.text).toBe(unknown.text);

      // The foreign session was NOT touched.
      await me(admin).expect(200);

      await attempt(viewer.handle).expect(400);

      await viewer.agent
        .delete(url(`/auth/system/sessions/${admin.handle}`))
        .expect(403);
      await viewer.agent
        .delete(url('/auth/system/sessions/others'))
        .expect(403);
    });

    it('AC-8 — no raw sid in any E1..E6 body, and a handle is not usable as a cookie', async () => {
      const a = await signIn('VIEWER');
      const b = await signIn('VIEWER');
      const t1 = await signIn('TARGET');
      const sa = await signIn('SA1');

      const bodies: string[] = [];
      bodies.push(JSON.stringify((await listOf(a)).others));
      bodies.push(
        (await a.agent.get(url('/auth/system/login-history')).expect(200)).text,
      );
      bodies.push(
        (
          await a.agent
            .delete(url(`/auth/system/sessions/${b.handle}`))
            .set('x-csrf-token', a.token)
            .expect(200)
        ).text,
      );
      bodies.push(
        (
          await a.agent
            .delete(url('/auth/system/sessions/others'))
            .set('x-csrf-token', a.token)
            .expect(200)
        ).text,
      );
      bodies.push(
        (
          await sa.agent
            .get(url(`/system-users/${ids.TARGET}/sessions`))
            .expect(200)
        ).text,
      );
      bodies.push(
        (
          await sa.agent
            .post(url(`/system-users/${ids.TARGET}/revoke-sessions`))
            .set('x-csrf-token', sa.token)
            .expect(200)
        ).text,
      );

      const joined = bodies.join('\n');
      for (const sid of [a.sid, b.sid, t1.sid, sa.sid]) {
        expect(joined).not.toContain(sid);
      }

      // The handle of a still-live session, offered as the cookie value: not a session.
      const live = await signIn('VIEWER');
      await request(server())
        .get(url('/auth/system/me'))
        .set('Cookie', `eb.sid=${live.handle}`)
        .expect(401);
      await request(server())
        .get(url('/auth/system/me'))
        .set('Cookie', `eb.sid=s:${live.handle}`)
        .expect(401);
    });

    it('AC-9 / AC-10 — DELETE sessions/others is the revoke-others handler (not :handle="others"), ends the rest and spares the caller', async () => {
      const a = await signIn('VIEWER');
      const b = await signIn('VIEWER');
      const c = await signIn('VIEWER');

      const res = await a.agent
        .delete(url('/auth/system/sessions/others'))
        .set('x-csrf-token', a.token)
        .expect(200);
      expect(res.body).toEqual({ revoked: 2 });

      await me(b).expect(401);
      await me(c).expect(401);
      await me(a).expect(200);
      expect(await members('VIEWER')).toEqual([a.sid]);

      const again = await a.agent
        .delete(url('/auth/system/sessions/others'))
        .set('x-csrf-token', a.token)
        .expect(200);
      expect(again.body).toEqual({ revoked: 0 });
    });
  });

  // ───────────────────────────── AC-12 .. AC-16 ─────────────────────────────

  describe('SUPER_ADMIN force sign-out and summary', () => {
    it('AC-12 / AC-13 — ends both sessions without suspending, writes exactly one FORCE_REVOKED row, and leaves the activity report unchanged', async () => {
      const t1 = await signIn('TARGET');
      const t2 = await signIn('TARGET');
      const sa = await signIn('SA1');

      const before = await activitySnapshot(sa);

      const res = await sa.agent
        .post(url(`/system-users/${ids.TARGET}/revoke-sessions`))
        .set('x-csrf-token', sa.token)
        .expect(200);
      expect(res.body).toEqual({ revoked: 2 });

      expect(await activitySnapshot(sa)).toEqual(before);

      await me(t1).expect(401);
      await me(t2).expect(401);

      const row = await prisma.systemUser.findUnique({
        where: { id: ids.TARGET },
        select: { isActive: true, deletedAt: true },
      });
      expect(row).toEqual({ isActive: true, deletedAt: null });

      const forced = await prisma.systemUserLoginLog.findMany({
        where: {
          systemUserId: ids.TARGET,
          status: LoginEventStatus.FORCE_REVOKED,
        },
      });
      expect(forced).toHaveLength(1);
      expect(forced[0]).toMatchObject({
        actorId: ids.SA1,
        ipAddress: null,
        userAgent: null,
        sessionRef: null,
      });

      // Not a suspension: the same password signs in again.
      const again = await signIn('TARGET');
      await me(again).expect(200);
    });

    it('AC-14 — ADMIN and VIEWER get 403 on E5 and E6 and the target is untouched; no cookie is 401', async () => {
      const t = await signIn('TARGET');
      const before = await redis.scard(sessionIndexKey(ids.TARGET));

      for (const who of ['ADMIN', 'VIEWER'] as const) {
        const d = await signIn(who);
        await d.agent
          .get(url(`/system-users/${ids.TARGET}/sessions`))
          .expect(403);
        await d.agent
          .post(url(`/system-users/${ids.TARGET}/revoke-sessions`))
          .set('x-csrf-token', d.token)
          .expect(403);
      }

      expect(await redis.scard(sessionIndexKey(ids.TARGET))).toBe(before);
      await me(t).expect(200);
      expect(await countRows('TARGET', LoginEventStatus.FORCE_REVOKED)).toBe(0);

      await request(server())
        .get(url(`/system-users/${ids.TARGET}/sessions`))
        .expect(401);
    });

    it('AC-15 — self is 400 (untouched); SUPER_ADMIN -> SUPER_ADMIN is allowed; deleted is 404; zero sessions is 200 {revoked:0} with no row', async () => {
      const sa1 = await signIn('SA1');
      const sa2 = await signIn('SA2');

      // Self.
      await sa1.agent
        .post(url(`/system-users/${ids.SA1}/revoke-sessions`))
        .set('x-csrf-token', sa1.token)
        .expect(400);
      await me(sa1).expect(200);
      expect(await members('SA1')).toEqual([sa1.sid]);

      // A peer SUPER_ADMIN (OQ-5).
      const peer = await sa1.agent
        .post(url(`/system-users/${ids.SA2}/revoke-sessions`))
        .set('x-csrf-token', sa1.token)
        .expect(200);
      expect(peer.body).toEqual({ revoked: 1 });
      await me(sa2).expect(401);

      // Zero sessions: idempotent, and nothing is written.
      const rowsBefore = await countRows(
        'TARGET',
        LoginEventStatus.FORCE_REVOKED,
      );
      const none = await sa1.agent
        .post(url(`/system-users/${ids.TARGET}/revoke-sessions`))
        .set('x-csrf-token', sa1.token)
        .expect(200);
      expect(none.body).toEqual({ revoked: 0 });
      expect(await countRows('TARGET', LoginEventStatus.FORCE_REVOKED)).toBe(
        rowsBefore,
      );

      // Soft-deleted and unknown targets are the same 404.
      await prisma.systemUser.update({
        where: { id: ids.TARGET },
        data: { deletedAt: new Date() },
      });
      const deleted = await sa1.agent
        .post(url(`/system-users/${ids.TARGET}/revoke-sessions`))
        .set('x-csrf-token', sa1.token)
        .expect(404);
      const unknown = await sa1.agent
        .post(url('/system-users/no-such-user/revoke-sessions'))
        .set('x-csrf-token', sa1.token)
        .expect(404);
      expect(deleted.text).toBe(unknown.text);
    });

    it('E6 without a CSRF token is 403', async () => {
      const sa = await signIn('SA1');
      await sa.agent
        .post(url(`/system-users/${ids.TARGET}/revoke-sessions`))
        .expect(403);
    });

    it('AC-16 — E5: count and last login for an active user, 0 for a suspended one, 404 for a deleted one', async () => {
      const t = await signIn('TARGET', UA_CHROME_WIN);
      await signIn('TARGET', UA_IPAD);
      const sa = await signIn('SA1');
      const getSummary = (id: string) =>
        sa.agent.get(url(`/system-users/${id}/sessions`));

      expect(await waitForRows('TARGET', LoginEventStatus.SUCCESS, 2)).toBe(2);
      const active = (await getSummary(ids.TARGET).expect(200)).body as Summary;
      expect(active.activeSessionCount).toBe(2);
      expect(active.lastLogin).not.toBeNull();
      expect(LOOPBACK).toContain(active.lastLogin?.ipAddress);
      expect(active.lastLogin?.device?.deviceType).toBe('tablet');
      expect(active.lastForceRevokedAt).toBeNull();
      expect(JSON.stringify(active)).not.toContain('actor');

      // Suspended: its sessions authenticate nothing, so the count is 0.
      await prisma.systemUser.update({
        where: { id: ids.TARGET },
        data: { isActive: false },
      });
      const suspended = (await getSummary(ids.TARGET).expect(200))
        .body as Summary;
      expect(suspended.activeSessionCount).toBe(0);
      await prisma.systemUser.update({
        where: { id: ids.TARGET },
        data: { isActive: true },
      });

      // Reading your own row is allowed.
      await getSummary(ids.SA1).expect(200);
      await me(t).expect(200);

      await prisma.systemUser.update({
        where: { id: ids.TARGET },
        data: { deletedAt: new Date() },
      });
      await getSummary(ids.TARGET).expect(404);
    });

    it("a force sign-out shows up on the target's own history and in E5, without naming the actor", async () => {
      const t = await signIn('TARGET');
      const sa = await signIn('SA1');
      await sa.agent
        .post(url(`/system-users/${ids.TARGET}/revoke-sessions`))
        .set('x-csrf-token', sa.token)
        .expect(200);

      const summary = (
        await sa.agent
          .get(url(`/system-users/${ids.TARGET}/sessions`))
          .expect(200)
      ).body as Summary;
      expect(summary.lastForceRevokedAt).not.toBeNull();
      expect(summary.activeSessionCount).toBe(0);

      const again = await signIn('TARGET');
      const history = (
        await again.agent.get(url('/auth/system/login-history')).expect(200)
      ).body as HistoryPage;
      const forced = history.data.find(
        (r) => r.status === LoginEventStatus.FORCE_REVOKED,
      );
      expect(forced).toBeDefined();
      expect(forced).toMatchObject({
        device: null,
        ipAddress: null,
        isCurrentSession: false,
      });
      expect(JSON.stringify(history)).not.toContain(ids.SA1);
      await me(t).expect(401);
    });
  });

  // ───────────────────────────── AC-17 .. AC-19 ─────────────────────────────

  describe('login history rows', () => {
    it('AC-17 — SUCCESS and FAILED_BAD_PASSWORD rows carry the ip and the parsed UA; unknown emails persist nothing; the 401 bodies are identical', async () => {
      const UNIQUE_UA = `${UA_FIREFOX_LINUX} e2e-sess-unique-${Date.now()}`;

      // Success.
      const ok = await signIn('TARGET', UA_CHROME_WIN);
      expect(await waitForRows('TARGET', LoginEventStatus.SUCCESS, 1)).toBe(1);
      const success = await prisma.systemUserLoginLog.findFirstOrThrow({
        where: { systemUserId: ids.TARGET, status: LoginEventStatus.SUCCESS },
      });
      expect(LOOPBACK).toContain(success.ipAddress);
      expect(success.userAgent).toBe(UA_CHROME_WIN);
      expect(success.sessionRef).toBe(ok.handle);
      expect(success.actorId).toBeNull();

      // Failures: wrong password, unknown email, suspended account — all through one helper.
      const fail = async (email: string, password: string) => {
        const agent = request.agent(server()).set('User-Agent', UNIQUE_UA);
        const token = await csrfFor(agent);
        return agent
          .post(url('/auth/system/login'))
          .set('x-csrf-token', token)
          .send({ email, password })
          .expect(401);
      };

      const wrong = await fail(EMAILS.TARGET, 'definitely-wrong-password');
      const unknown = await fail(NOBODY, PASSWORD);
      const suspended = await fail(EMAILS.SUSPENDED, PASSWORD);

      expect(wrong.body).toEqual(unknown.body);
      expect(suspended.body).toEqual(unknown.body);
      expect(wrong.headers['set-cookie']).toBeUndefined();

      expect(
        await waitForRows('TARGET', LoginEventStatus.FAILED_BAD_PASSWORD, 1),
      ).toBe(1);
      expect(
        await waitForRows('SUSPENDED', LoginEventStatus.FAILED_BAD_PASSWORD, 1),
      ).toBe(1);
      const failed = await prisma.systemUserLoginLog.findFirstOrThrow({
        where: {
          systemUserId: ids.TARGET,
          status: LoginEventStatus.FAILED_BAD_PASSWORD,
        },
      });
      expect(LOOPBACK).toContain(failed.ipAddress);
      expect(failed.userAgent).toBe(UNIQUE_UA);
      expect(failed.sessionRef).toBeNull();

      // The unknown email created nothing: of the three attempts that used this UA, exactly two rows exist.
      await new Promise((r) => setTimeout(r, 300)); // an absence has no event to await
      expect(
        await prisma.systemUserLoginLog.count({
          where: { userAgent: UNIQUE_UA },
        }),
      ).toBe(2);
    });

    it('a successful login response is unchanged: the user DTO and an eb.sid cookie', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      const res = await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: EMAILS.VIEWER, password: PASSWORD })
        .expect(200);
      expect(Object.keys(res.body as object).sort()).toEqual(
        ['email', 'firstName', 'id', 'lastName', 'role'].sort(),
      );
      expect(readCookie(res, 'eb.sid')).toContain('HttpOnly');
    });

    it('AC-19 — E4 is the caller\'s own rows, newest first, hides a −91 d row, marks "this device", and validates paging', async () => {
      const a = await signIn('VIEWER');
      expect(await waitForRows('VIEWER', LoginEventStatus.SUCCESS, 1)).toBe(1);

      const now = Date.now();
      const seeded = [
        { id: 'e2e-sess-log-old-91d', ageDays: 91 },
        { id: 'e2e-sess-log-1d', ageDays: 1 },
        { id: 'e2e-sess-log-2d', ageDays: 2 },
      ];
      for (const s of seeded) {
        seededLogIds.push(s.id);
        await prisma.systemUserLoginLog.create({
          data: {
            id: s.id,
            systemUserId: ids.VIEWER,
            status: LoginEventStatus.FAILED_BAD_PASSWORD,
            ipAddress: '198.51.100.9',
            userAgent: UA_IPAD,
            createdAt: new Date(now - s.ageDays * DAY_MS),
          },
        });
      }
      // Another user's row must never appear.
      seededLogIds.push('e2e-sess-log-other-user');
      await prisma.systemUserLoginLog.create({
        data: {
          id: 'e2e-sess-log-other-user',
          systemUserId: ids.ADMIN,
          status: LoginEventStatus.SUCCESS,
        },
      });

      const page = (
        await a.agent.get(url('/auth/system/login-history')).expect(200)
      ).body as HistoryPage;

      expect(page.data.map((r) => r.id)).toEqual([
        page.data[0].id, // the login just made (newest)
        'e2e-sess-log-1d',
        'e2e-sess-log-2d',
      ]);
      expect(page.data[0].status).toBe(LoginEventStatus.SUCCESS);
      expect(page.data[0].isCurrentSession).toBe(true);
      expect(page.data[1].isCurrentSession).toBe(false);
      expect(page.data[1].device).toMatchObject({ os: 'iPadOS' });
      expect(page.meta).toEqual({
        page: 1,
        limit: 10,
        total: 3,
        totalPages: 1,
      });
      expect(JSON.stringify(page)).not.toContain('e2e-sess-log-old-91d');
      expect(JSON.stringify(page)).not.toContain('e2e-sess-log-other-user');

      await a.agent.get(url('/auth/system/login-history?limit=15')).expect(400);
      await a.agent.get(url('/auth/system/login-history?page=0')).expect(400);
      await a.agent.get(url('/auth/system/login-history?page=abc')).expect(400);

      const far = (
        await a.agent
          .get(url('/auth/system/login-history?page=999&limit=10'))
          .expect(200)
      ).body as HistoryPage;
      expect(far.data).toEqual([]);
      expect(far.meta).toEqual({
        page: 999,
        limit: 10,
        total: 3,
        totalPages: 1,
      });

      const small = (
        await a.agent
          .get(url('/auth/system/login-history?limit=10&page=1'))
          .expect(200)
      ).body as HistoryPage;
      expect(small.data).toHaveLength(3);
    });
  });

  // ───────────────────────────── gate, auth, contract ─────────────────────────────

  describe('gates and contract', () => {
    it('a mustChangePassword user is gated (403) on E1 — none of E1..E6 is exempt', async () => {
      const g = await signIn('GATED');
      await g.agent.get(url('/auth/system/sessions')).expect(403);
      await g.agent.get(url('/auth/system/login-history')).expect(403);
      await g.agent
        .delete(url('/auth/system/sessions/others'))
        .set('x-csrf-token', g.token)
        .expect(403);
    });

    it('E1..E4 without a session are 401', async () => {
      await request(server()).get(url('/auth/system/sessions')).expect(401);
      await request(server())
        .get(url('/auth/system/login-history'))
        .expect(401);
    });

    it('AC-26 — all six routes are in the OpenAPI document with their error responses', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('e2e').build(),
      );
      const find = (suffix: string, method: string) => {
        const path = Object.keys(document.paths).find((p) =>
          p.endsWith(suffix),
        );
        expect(path).toBeDefined();
        const op = (
          document.paths[path as string] as Record<
            string,
            { responses: Record<string, unknown> }
          >
        )[method];
        expect(op).toBeDefined();
        return Object.keys(op.responses);
      };

      expect(find('/auth/system/sessions', 'get')).toEqual(
        expect.arrayContaining(['200', '401', '403', '503']),
      );
      expect(find('/auth/system/sessions/others', 'delete')).toEqual(
        expect.arrayContaining(['200', '401', '403', '503']),
      );
      expect(find('/auth/system/sessions/{handle}', 'delete')).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '503']),
      );
      expect(find('/auth/system/login-history', 'get')).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '503']),
      );
      expect(find('/system-users/{id}/sessions', 'get')).toEqual(
        expect.arrayContaining(['200', '401', '403', '404', '503']),
      );
      expect(find('/system-users/{id}/revoke-sessions', 'post')).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '503']),
      );
    });
  });
});
