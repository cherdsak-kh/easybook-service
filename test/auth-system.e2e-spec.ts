import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { SESSION_KEY_PREFIX } from '../src/redis/redis.constants';
import {
  clearThrottleCounters,
  cookieValue,
  createE2eApp,
  prismaOf,
  purgeE2eUsers,
  readCookie,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(120_000);

const PREFIX = 'e2e-auth-';
const PASSWORD = 'e2e-correct-horse-battery';
const SUPER = `${PREFIX}super@easybook.local`;
const STAFF = `${PREFIX}staff@easybook.local`;
const SUSPENDED = `${PREFIX}suspended@easybook.local`;
const DELETED = `${PREFIX}deleted@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

/** `eb.sid` is a signed cookie: `s:<sid>.<hmac>`. The Redis key uses the bare `<sid>`. */
const sidOf = (cookie: string | undefined): string => {
  const value = decodeURIComponent(cookieValue(cookie) ?? '');
  return value.startsWith('s:')
    ? value.slice(2, value.lastIndexOf('.'))
    : value;
};

describe('Auth — /auth/system (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  const server = () => app.getHttpServer();

  /** Fetches a CSRF token and leaves the `eb.csrf` cookie on the agent. */
  const csrfFor = async (agent: request.Agent): Promise<string> => {
    const res = await agent.get(url('/auth/system/csrf')).expect(200);
    return (res.body as { csrfToken: string }).csrfToken;
  };

  const seed = async () => {
    const password = new PasswordService();
    const passwordHash = await password.hash(PASSWORD);
    const base = { passwordHash, position: 'Director', department: 'IT' };

    await prisma.systemUser.createMany({
      data: [
        {
          email: SUPER,
          name: 'E2E Super',
          role: SystemRole.SUPER_ADMIN,
          ...base,
        },
        { email: STAFF, name: 'E2E Staff', role: SystemRole.STAFF, ...base },
        {
          email: SUSPENDED,
          name: 'E2E Suspended',
          role: SystemRole.STAFF,
          isActive: false,
          ...base,
        },
        {
          email: DELETED,
          name: 'E2E Deleted',
          role: SystemRole.STAFF,
          deletedAt: new Date(),
          ...base,
        },
      ],
    });
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await purgeE2eUsers(prisma, PREFIX);
    await seed();
  });

  beforeEach(async () => {
    // Keep each test's rate-limit budget independent of the previous test's failures.
    await clearThrottleCounters(redis);
  });

  afterAll(async () => {
    await purgeE2eUsers(prisma, PREFIX);
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ─────────────────────────────── CSRF ───────────────────────────────

  describe('CSRF', () => {
    it('GET /auth/system/csrf issues a token and an httpOnly eb.csrf cookie (no session required)', async () => {
      const res = await request(server())
        .get(url('/auth/system/csrf'))
        .expect(200);

      expect(typeof (res.body as { csrfToken: string }).csrfToken).toBe(
        'string',
      );
      expect(readCookie(res, 'eb.csrf')).toContain('HttpOnly');
    });

    it('AC-15 — POST /login with a valid body but no x-csrf-token → 403, and no session is created', async () => {
      const agent = request.agent(server());
      await csrfFor(agent);

      const res = await agent
        .post(url('/auth/system/login'))
        .send({ email: SUPER, password: PASSWORD })
        .expect(403);

      expect((res.body as { message: string }).message).toBe(
        'Invalid CSRF token.',
      );
      expect(readCookie(res, 'eb.sid')).toBeUndefined();
    });

    it('AC-16 — a mismatched/stale CSRF token on a POST → 403', async () => {
      const agent = request.agent(server());
      await csrfFor(agent);

      await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', 'a-stale-token')
        .send({ email: SUPER, password: PASSWORD })
        .expect(403);
    });

    it('AC-17 — GET requests never require a CSRF token', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD })
        .expect(200);

      // No x-csrf-token header on either safe method.
      await agent.get(url('/auth/system/me')).expect(200);
      await agent.get(url('/system-users')).expect(200);
    });

    it('AC-18 — POST /line/webhook still succeeds with a valid signature and NO CSRF token', async () => {
      const secret = process.env.LINE_CHANNEL_SECRET;
      expect(secret).toBeTruthy();

      const body = JSON.stringify({ destination: 'Uxxxx', events: [] });
      const signature = createHmac('sha256', secret!)
        .update(body)
        .digest('base64');

      await request(server())
        .post(url('/line/webhook'))
        .set('Content-Type', 'application/json')
        .set('x-line-signature', signature)
        .send(body)
        .expect(200)
        .expect({ ok: true });
    });

    it('AC-18 (negative) — the webhook still rejects a bad signature, so rawBody survived the wiring', async () => {
      const body = JSON.stringify({ destination: 'Uxxxx', events: [] });
      await request(server())
        .post(url('/line/webhook'))
        .set('Content-Type', 'application/json')
        .set('x-line-signature', 'not-a-signature')
        .send(body)
        .expect(401);
    });
  });

  // ─────────────────────────────── Login ───────────────────────────────

  describe('login', () => {
    it('AC-4 / AC-5 — valid credentials → 200, httpOnly eb.sid cookie, and a body with no password digest', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);

      const res = await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD })
        .expect(200);

      const cookie = readCookie(res, 'eb.sid');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/');
      expect(res.body).toMatchObject({
        email: SUPER,
        name: 'E2E Super',
        role: SystemRole.SUPER_ADMIN,
      });
      expect((res.body as { id: string }).id).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('$argon2id$');
    });

    it('AC-8 — the session id is regenerated on login (fixation defence)', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);

      const first = await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD })
        .expect(200);
      const sidBefore = sidOf(readCookie(first, 'eb.sid'));

      // Log in again while holding the first session: regenerate() must mint a new id.
      const second = await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD })
        .expect(200);
      const sidAfter = sidOf(readCookie(second, 'eb.sid'));

      expect(sidBefore).toBeTruthy();
      expect(sidAfter).toBeTruthy();
      expect(sidAfter).not.toEqual(sidBefore);
      // The old session key is gone; only the new one authenticates.
      await expect(
        redis.exists(`${SESSION_KEY_PREFIX}${sidBefore}`),
      ).resolves.toBe(0);
    });

    it('AC-9 — lastLoginAt is stamped on success', async () => {
      const before = await prisma.systemUser.findUnique({
        where: { email: SUPER },
        select: { lastLoginAt: true },
      });

      const agent = request.agent(server());
      const token = await csrfFor(agent);
      await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD })
        .expect(200);

      const after = await prisma.systemUser.findUnique({
        where: { email: SUPER },
        select: { lastLoginAt: true },
      });
      expect(after?.lastLoginAt).toBeTruthy();
      expect(after?.lastLoginAt?.getTime()).toBeGreaterThan(
        before?.lastLoginAt?.getTime() ?? 0,
      );
    });

    it('AC-10 — the session is written to Redis under eb:sess:<sid>', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      const res = await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD })
        .expect(200);

      const sid = sidOf(readCookie(res, 'eb.sid'));
      await expect(redis.exists(`${SESSION_KEY_PREFIX}${sid}`)).resolves.toBe(
        1,
      );
    });

    // AC-6 + AC-31: four causes, one indistinguishable response.
    it('AC-6 / AC-31 — wrong password, unknown email, suspended and soft-deleted all return the identical 401', async () => {
      const attempt = async (email: string, password: string) => {
        await clearThrottleCounters(redis);
        const agent = request.agent(server());
        const token = await csrfFor(agent);
        const res = await agent
          .post(url('/auth/system/login'))
          .set('x-csrf-token', token)
          .send({ email, password })
          .expect(401);
        expect(readCookie(res, 'eb.sid')).toBeUndefined();
        return res.body as Record<string, unknown>;
      };

      const bodies = [
        await attempt(SUPER, 'definitely-the-wrong-password'),
        await attempt(`${PREFIX}nobody@easybook.local`, PASSWORD),
        await attempt(SUSPENDED, PASSWORD),
        await attempt(DELETED, PASSWORD),
      ];

      for (const body of bodies) {
        expect(body).toEqual(bodies[0]);
        expect(body.message).toBe('Invalid email or password.');
      }
    });

    it('rejects an unknown body field and a malformed email with 400 (forbidNonWhitelisted)', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);

      await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD, _csrf: token })
        .expect(400);

      await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: 'not-an-email', password: PASSWORD })
        .expect(400);
    });
  });

  // ──────────────────────── /me, logout, session ────────────────────────

  describe('session lifecycle', () => {
    const loggedInAgent = async (email = SUPER) => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      const res = await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email, password: PASSWORD })
        .expect(200);
      return { agent, token, sid: sidOf(readCookie(res, 'eb.sid')) };
    };

    it('AC-32 — GET /auth/system/me returns the profile with no deletedAt and no password digest', async () => {
      const { agent } = await loggedInAgent();
      const res = await agent.get(url('/auth/system/me')).expect(200);

      expect(res.body).toMatchObject({
        email: SUPER,
        role: SystemRole.SUPER_ADMIN,
        isActive: true,
      });
      expect(Object.keys(res.body as object)).not.toContain('deletedAt');
      expect(Object.keys(res.body as object)).not.toContain('passwordHash');
      expect(Object.keys(res.body as object).sort()).toEqual(
        [
          'createdAt',
          'department',
          'email',
          'id',
          'isActive',
          'lastLoginAt',
          'lineUserId',
          'name',
          'phoneNumber',
          'position',
          'profilePictureUrl',
          'role',
        ].sort(),
      );
    });

    it('GET /auth/system/me with no session → 401', async () => {
      await request(server()).get(url('/auth/system/me')).expect(401);
    });

    it('AC-12 — logout destroys the Redis key, and replaying the cookie is rejected', async () => {
      const { agent, token, sid } = await loggedInAgent();
      await expect(redis.exists(`${SESSION_KEY_PREFIX}${sid}`)).resolves.toBe(
        1,
      );

      await agent
        .post(url('/auth/system/logout'))
        .set('x-csrf-token', token)
        .expect(200)
        .expect({ success: true });

      await expect(redis.exists(`${SESSION_KEY_PREFIX}${sid}`)).resolves.toBe(
        0,
      );
      await agent.get(url('/auth/system/me')).expect(401);
    });

    it('a replayed logout returns 401 — the session no longer exists', async () => {
      const { agent, token } = await loggedInAgent();
      await agent
        .post(url('/auth/system/logout'))
        .set('x-csrf-token', token)
        .expect(200);
      await agent
        .post(url('/auth/system/logout'))
        .set('x-csrf-token', token)
        .expect(401);
    });

    it('logout requires a CSRF token', async () => {
      const { agent } = await loggedInAgent();
      await agent.post(url('/auth/system/logout')).expect(403);
    });

    it('AC-25 — STAFF calling POST /system-users → 403; no session → 401', async () => {
      const { agent, token } = await loggedInAgent(STAFF);

      await agent
        .post(url('/system-users'))
        .set('x-csrf-token', token)
        .send({
          email: `${PREFIX}new@easybook.local`,
          password: 'a-long-enough-password',
          name: 'Nope',
          position: 'p',
          department: 'd',
        })
        .expect(403);

      const anon = request.agent(server());
      const anonToken = await csrfFor(anon);
      await anon
        .post(url('/system-users'))
        .set('x-csrf-token', anonToken)
        .send({
          email: `${PREFIX}new2@easybook.local`,
          password: 'a-long-enough-password',
          name: 'Nope',
          position: 'p',
          department: 'd',
        })
        .expect(401);
    });

    it('AC-11 — the same cookie still authenticates after the backend process is replaced', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      const login = await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: PASSWORD })
        .expect(200);
      const signedCookie = readCookie(login, 'eb.sid')!.split(';')[0];
      expect(signedCookie).toBeTruthy();

      // Tear the app down and build a brand-new one. Process memory is gone; Redis is not.
      // This is the core proof that sessions do not live in a MemoryStore.
      await app.close();
      app = await createE2eApp();
      prisma = prismaOf(app);
      redis = redisOf(app);
      await waitForRedis(redis);

      await request(server())
        .get(url('/auth/system/me'))
        .set('Cookie', signedCookie)
        .expect(200);
    });
  });

  // ─────────────────────────── Rate limiting ───────────────────────────

  describe('login rate limiting', () => {
    it('AC-19 — the 6th attempt for one (IP + email) is 429 with Retry-After, even with the correct password', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      const login = (password: string) =>
        agent
          .post(url('/auth/system/login'))
          .set('x-csrf-token', token)
          .send({ email: SUPER, password });

      for (let i = 0; i < 5; i++) {
        await login('wrong-password').expect(401);
      }

      const res = await login(PASSWORD).expect(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it("AC-21 — a successful login clears that email's failure counter", async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      const login = (password: string) =>
        agent
          .post(url('/auth/system/login'))
          .set('x-csrf-token', token)
          .send({ email: SUPER, password });

      for (let i = 0; i < 4; i++) await login('wrong-password').expect(401);
      await login(PASSWORD).expect(200); // 5th attempt, succeeds, clears the counter

      // The counter is gone, so five more failures are allowed before the limit trips again.
      for (let i = 0; i < 4; i++) await login('wrong-password').expect(401);
      await login(PASSWORD).expect(200);
    });

    it('AC-20 — spraying one password across many emails trips the per-IP limit at 20 / 15 min', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      const spray = (n: number) =>
        agent
          .post(url('/auth/system/login'))
          .set('x-csrf-token', token)
          .send({
            email: `${PREFIX}spray-${n}@easybook.local`,
            password: 'one-password-for-all',
          });

      // Each email is distinct, so the (IP + email) counter never exceeds 1. Only the per-IP
      // counter accumulates; the 21st request is over its limit of 20.
      for (let n = 0; n < 20; n++) await spray(n).expect(401);

      const res = await spray(20).expect(429);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('AC-22 — the counters live in Redis, so they survive a backend restart', async () => {
      const agent = request.agent(server());
      const token = await csrfFor(agent);
      await agent
        .post(url('/auth/system/login'))
        .set('x-csrf-token', token)
        .send({ email: SUPER, password: 'wrong-password' })
        .expect(401);

      const keysBefore = await redis.keys('eb:throttle:login:*');
      expect(keysBefore.length).toBeGreaterThan(0);

      await app.close();
      app = await createE2eApp();
      prisma = prismaOf(app);
      redis = redisOf(app);
      await waitForRedis(redis);

      const keysAfter = await redis.keys('eb:throttle:login:*');
      expect(keysAfter.sort()).toEqual(keysBefore.sort());
      await expect(redis.get(keysBefore[0])).resolves.toBe('1');
    });
  });

  // ───────────────────────────── Health ─────────────────────────────

  it('AC-14 — GET /health reports redis alongside db, and never touches the session store', async () => {
    const res = await request(server()).get(url('/health')).expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(['up', 'down']).toContain((res.body as { db: string }).db);
    expect(['up', 'down']).toContain((res.body as { redis: string }).redis);
  });
});
