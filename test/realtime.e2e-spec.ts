import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppAccess, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { LineService } from '../src/line/line.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  REALTIME_ADMIN_NAMESPACE,
  REALTIME_ERRORS,
  REALTIME_EVENTS,
  SESSION_CLOSED_REASONS,
} from '../src/realtime/realtime.constants';
import { sessionCookieName } from '../src/session/session.middleware';
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

jest.setTimeout(120_000);

const SU_PREFIX = 'e2e-rt-';
const LU_PREFIX = 'e2e-rtlu-';
const PASSWORD = 'e2e-correct-horse-battery';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const STAFF = `${SU_PREFIX}staff@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;

/**
 * The suite pins its own allowlist rather than inheriting the developer's `.env`, so the
 * `FORBIDDEN_ORIGIN` case can never pass or fail for an environmental reason. A comma-separated
 * value also exercises `resolveCorsOrigin`'s list-splitting on the socket side.
 */
const ALLOWED_ORIGIN = 'http://localhost:2200';
const CORS_ORIGIN = `${ALLOWED_ORIGIN},http://127.0.0.1:2200`;
const FOREIGN_ORIGIN = 'http://evil.example';

/**
 * 500 ms instead of the production 30 000 ms. The stated 35 s exposure window is arithmetic on this
 * interval, not a separate code path, so exercising the same mechanism 60× faster tests the same
 * guarantee. It MUST be set before the app boots — `RealtimeGateway` reads it via `ConfigService`
 * once, in `afterInit`.
 */
const SWEEP_INTERVAL_MS = '500';

/** The bound the revocation window is asserted against (design §4.4). */
const REVOCATION_BUDGET_MS = 3_000;

/** Exactly `LineUserResponseDto`'s keys — the whole of AC B13 in one list. */
const LINE_USER_DTO_KEYS = [
  'id',
  'lineUserId',
  'displayName',
  'pictureUrl',
  'statusMessage',
  'richMenuType',
  'access',
  'followedAt',
  'registration',
].sort();

interface Session {
  agent: request.Agent;
  token: string;
  /** The `eb.sid=<value>` pair, ready for a socket's `Cookie` request header. */
  cookie: string;
}

interface LineUserEvent {
  id: string;
  lineUserId: string;
  access: AppAccess;
  displayName: string | null;
  registration: unknown;
}

/** engine.io-client surfaces an engine-level rejection as a transport error, not a namespace code. */
type TransportError = Error & { description?: unknown };

describe('Realtime gateway (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let baseUrl: string;
  let cookieName: string;
  let passwordHash: string;
  let lineUserId: string;

  /** Every socket this suite opens, so `afterEach` can guarantee none is left alive. */
  const openSockets: Socket[] = [];
  /** Measured time from "the revoking write returned" to "the socket was closed", for the log. */
  const revocationTimings: Array<[string, number]> = [];

  const envBackup: Record<string, string | undefined> = {};
  const server = () => app.getHttpServer();

  // ───────────────────────────── helpers ─────────────────────────────

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
    // Strip the attributes; a request `Cookie` header carries only `name=value`.
    return { agent, token, cookie: raw.split(';')[0] };
  };

  /**
   * A real `socket.io-client` against the real listening server.
   *
   * `forceNew` is NOT optional: socket.io-client caches one `Manager` per origin, so without it a
   * second socket would silently reuse the FIRST socket's engine connection — and therefore the
   * first socket's `Cookie`/`Origin` headers. Every multi-identity assertion here would then pass
   * for the wrong reason.
   *
   * The transport ladder is left at the default `['polling', 'websocket']`, which is what a browser
   * does, so the handshake is exercised over the same path production takes.
   */
  const connectSocket = (opts: {
    cookie?: string;
    origin?: string;
    namespace?: string;
  }): Socket => {
    const extraHeaders: Record<string, string> = {};
    if (opts.cookie) extraHeaders.Cookie = opts.cookie;
    if (opts.origin) extraHeaders.Origin = opts.origin;

    const socket = io(
      `${baseUrl}${opts.namespace ?? REALTIME_ADMIN_NAMESPACE}`,
      {
        path: '/socket.io',
        forceNew: true,
        reconnection: false,
        extraHeaders,
      },
    );
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
        reject(
          new Error(
            `Socket was rejected instead of connecting: ${error.message}`,
          ),
        );
      });
    });

  const waitForConnectError = (
    socket: Socket,
    timeoutMs = 5_000,
  ): Promise<TransportError> =>
    new Promise<TransportError>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`No connect_error arrived within ${timeoutMs}ms.`)),
        timeoutMs,
      );
      socket.once('connect_error', (error: TransportError) => {
        clearTimeout(timer);
        resolve(error);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        reject(new Error('Socket connected, but a rejection was expected.'));
      });
    });

  /** Event-driven wait — never a fixed sleep, which is what makes socket suites flaky. */
  const nextEvent = <T>(
    socket: Socket,
    event: string,
    timeoutMs = REVOCATION_BUDGET_MS,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const handler = (payload: T) => {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(
          new Error(`Timed out after ${timeoutMs}ms waiting for "${event}".`),
        );
      }, timeoutMs);
      socket.on(event, handler);
    });

  /**
   * The ONLY fixed wait in the suite, and only ever used to prove an ABSENCE (no duplicate event,
   * no event at all). There is no event to await for something that must not happen.
   */
  const settle = (ms = 300): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const purgeLineUsers = () =>
    prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );

  /**
   * Restores the three fixture users to their canonical state rather than re-creating them: the
   * B12 cases deliberately delete / suspend / demote / gate them, and a full purge would re-hash the
   * password on every test for no benefit.
   */
  const resetSystemUsers = async () => {
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [STAFF, SystemRole.STAFF],
    ] as Array<[string, SystemRole]>) {
      await prisma.systemUser.update({
        where: { email },
        data: {
          role,
          isActive: true,
          deletedAt: null,
          mustChangePassword: false,
          passwordHash,
        },
      });
    }
  };

  const seedSystemUsers = async () => {
    await purgeE2eUsers(prisma, SU_PREFIX);
    const base = {
      passwordHash,
      // The model default is TRUE (deny by default); these fixtures are already onboarded, so
      // omitting this would gate every one of them into a 403.
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
  };

  const seedLineUser = async () => {
    await purgeLineUsers();
    const created = await prisma.lineUser.create({
      data: {
        lineUserId: `${LU_PREFIX}subject`,
        displayName: 'Realtime Subject',
        access: AppAccess.PENDING,
      },
      select: { id: true },
    });
    lineUserId = created.id;
  };

  // ───────────────────────────── lifecycle ─────────────────────────────

  beforeAll(async () => {
    // BEFORE boot, or neither value is read: the gateway resolves the sweep period once in
    // `afterInit`, and the adapter resolves the origin allowlist once in `createIOServer`.
    for (const key of ['WS_REVALIDATE_INTERVAL_MS', 'CORS_ORIGIN']) {
      envBackup[key] = process.env[key];
    }
    process.env.WS_REVALIDATE_INTERVAL_MS = SWEEP_INTERVAL_MS;
    process.env.CORS_ORIGIN = CORS_ORIGIN;

    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    cookieName = sessionCookieName(app.get(ConfigService));
    await waitForRedis(redis);

    // `createE2eApp` only calls `app.init()`. Socket.IO attaches to the underlying HTTP server at
    // init, but a client cannot reach it until that server is actually LISTENING.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    // `PATCH /line-users/:id` applies the rich menu and pushes to LINE. Stub both so the emit
    // round-trip never touches the real Messaging API — the switch behaviour is unit-tested.
    const line = app.get(LineService);
    jest.spyOn(line, 'findRichMenuId').mockResolvedValue('rm-e2e');
    jest.spyOn(line, 'linkRichMenuToUser').mockResolvedValue(undefined);
    jest.spyOn(line, 'push').mockResolvedValue(undefined);

    passwordHash = await new PasswordService().hash(PASSWORD);
    await seedSystemUsers();
  }, 60_000);

  beforeEach(async () => {
    await clearThrottleCounters(redis);
    await resetSystemUsers();
    await seedLineUser();
  });

  afterEach(() => {
    // A leaked socket keeps an engine.io session (and its timers) alive and hangs `app.close()`.
    while (openSockets.length > 0) {
      const socket = openSockets.pop();
      socket?.removeAllListeners();
      socket?.disconnect();
    }
  });

  afterAll(async () => {
    if (revocationTimings.length > 0) {
      process.stdout.write(
        `\n  [B12] measured time-to-disconnect at WS_REVALIDATE_INTERVAL_MS=${SWEEP_INTERVAL_MS}: ` +
          revocationTimings.map(([n, ms]) => `${n}=${ms}ms`).join(', ') +
          '\n',
      );
    }
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeLineUsers();
    await clearThrottleCounters(redis);
    await app.close();

    // Restore, or a 500 ms sweep leaks into whichever suite Jest runs next in this worker.
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ───────────────────────────── handshake ─────────────────────────────

  describe('handshake', () => {
    /**
     * **AC-B1 — the default `/` namespace is closed by an explicit allowlist, not by absence.**
     *
     * `socket.io`'s `Server` constructor runs `this.sockets = this.of("/")` unconditionally, so `/`
     * always exists: "no gateway declares it" closes nothing, and before design Amendment A1 an
     * anonymous, cookie-less socket connected to `/` and was held indefinitely. What closes it now is
     * `sealNamespaces` in `SessionIoAdapter` — anything outside `REALTIME_NAMESPACE_ALLOWLIST` gets a
     * refusing middleware.
     *
     * Rejection is event-driven via `waitForConnectError`, which resolves on `connect_error`, rejects
     * on `connect` ("a rejection was expected") and rejects on a bounded 5 s timeout — so refused,
     * accepted and hung are three distinct outcomes. No `settle()`, no sleep.
     */
    it('AC-B1 — an anonymous socket to the default "/" namespace is refused', async () => {
      const socket = connectSocket({ namespace: '/' });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
      expect(socket.connected).toBe(false);
    });

    it('AC-B1 — even a live ADMIN session cannot connect to "/"', async () => {
      // The boundary is the NAMESPACE, not the cookie: `/` serves nobody, so a valid session buys
      // nothing there. `UNAUTHENTICATED` is the right status CLASS even for an authenticated caller.
      const { cookie } = await login(ADMIN);
      const socket = connectSocket({ cookie, namespace: '/' });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
      expect(socket.connected).toBe(false);
    });

    it('AC-B1 — an undeclared namespace is refused by socket.io as "Invalid namespace"', async () => {
      // A namespace that does not exist never reaches our middleware — socket.io refuses it first,
      // with ITS string. Two structurally different refusals, pinned so nobody "harmonises" them.
      const socket = connectSocket({ namespace: '/nope' });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe('Invalid namespace');
      expect(Object.values(REALTIME_ERRORS)).not.toContain(error.message);
      expect(socket.connected).toBe(false);
    });

    it('an authenticated ADMIN connects to /admin', async () => {
      const { cookie } = await login(ADMIN);
      const socket = connectSocket({ cookie });

      await waitForConnect(socket);
      expect(socket.connected).toBe(true);
    });

    it('an authenticated SUPER_ADMIN connects to /admin', async () => {
      const { cookie } = await login(SUPER);
      const socket = connectSocket({ cookie });

      await waitForConnect(socket);
      expect(socket.connected).toBe(true);
    });

    it('AC-B3 — no cookie is UNAUTHENTICATED, and no event is ever delivered', async () => {
      const socket = connectSocket({});
      const events: unknown[] = [];
      for (const event of Object.values(REALTIME_EVENTS)) {
        socket.on(event, (payload: unknown) => events.push(payload));
      }

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
      expect(socket.connected).toBe(false);

      await settle();
      expect(events).toEqual([]);
    });

    it('AC-B4 — a STAFF session is FORBIDDEN, not UNAUTHENTICATED', async () => {
      const { cookie } = await login(STAFF);
      const socket = connectSocket({ cookie });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.forbidden);
      expect(socket.connected).toBe(false);
    });

    it('AC-B6 — mustChangePassword is FORBIDDEN even for an ADMIN', async () => {
      const { cookie } = await login(ADMIN);
      await prisma.systemUser.update({
        where: { email: ADMIN },
        data: { mustChangePassword: true },
      });

      const socket = connectSocket({ cookie });
      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.forbidden);
    });

    it('AC-B5 — a soft-deleted admin and a suspended admin are both UNAUTHENTICATED (orthogonal)', async () => {
      const deleted = await login(ADMIN);
      await prisma.systemUser.update({
        where: { email: ADMIN },
        data: { deletedAt: new Date() },
      });
      const deletedError = await waitForConnectError(
        connectSocket({ cookie: deleted.cookie }),
      );
      expect(deletedError.message).toBe(REALTIME_ERRORS.unauthenticated);

      // A soft-deleted row is normally still `isActive: true`, so the two flags must be checked
      // independently. Restore, then suspend without deleting.
      await prisma.systemUser.update({
        where: { email: ADMIN },
        data: { deletedAt: null },
      });
      const suspended = await login(ADMIN);
      await prisma.systemUser.update({
        where: { email: ADMIN },
        data: { isActive: false },
      });
      const suspendedError = await waitForConnectError(
        connectSocket({ cookie: suspended.cookie }),
      );
      expect(suspendedError.message).toBe(REALTIME_ERRORS.unauthenticated);
    });
  });

  // ───────────────────────── CSWSH / Origin control ─────────────────────────

  describe('AC-B2 — Origin validation (the CSWSH control)', () => {
    it('an allowlisted Origin connects', async () => {
      const { cookie } = await login(ADMIN);
      const socket = connectSocket({ cookie, origin: ALLOWED_ORIGIN });

      await waitForConnect(socket);
      expect(socket.connected).toBe(true);
    });

    it('a foreign Origin never connects, even with a perfectly valid session cookie', async () => {
      const { cookie } = await login(ADMIN);
      const socket = connectSocket({ cookie, origin: FOREIGN_ORIGIN });

      // `allowRequest` rejects at the ENGINE level, before the namespace middleware runs, so the
      // client sees a transport error carrying the 403 rather than a namespace error code. The
      // `FORBIDDEN_ORIGIN` string itself is pinned by the raw-handshake test below.
      await waitForConnectError(socket);
      expect(socket.connected).toBe(false);
    });

    it('the raw engine handshake answers 403 FORBIDDEN_ORIGIN for a foreign Origin and 200 for an allowlisted one', async () => {
      // The engine path is outside the `/api/v1` global prefix — the gateway attaches to the raw
      // HTTP server, not to the Nest router.
      const rejected = await request(server())
        .get('/socket.io/?EIO=4&transport=polling')
        .set('Origin', FOREIGN_ORIGIN)
        .expect(403);
      expect((rejected.body as { message: string }).message).toBe(
        REALTIME_ERRORS.forbiddenOrigin,
      );

      await request(server())
        .get('/socket.io/?EIO=4&transport=polling')
        .set('Origin', ALLOWED_ORIGIN)
        .expect(200);
    });
  });

  // ───────────────────────── the emit round trip ─────────────────────────

  describe('AC-B8/B9/B13/X2 — a real HTTP mutation reaches a real socket', () => {
    it('PATCH /line-users/:id delivers exactly one lineUser.updated, carrying the row, to every connected admin', async () => {
      const admin = await login(ADMIN);
      const superAdmin = await login(SUPER);
      const adminSocket = connectSocket({ cookie: admin.cookie });
      const superSocket = connectSocket({ cookie: superAdmin.cookie });
      await Promise.all([
        waitForConnect(adminSocket),
        waitForConnect(superSocket),
      ]);

      const seenByAdmin: LineUserEvent[] = [];
      adminSocket.on(REALTIME_EVENTS.lineUserUpdated, (p: LineUserEvent) =>
        seenByAdmin.push(p),
      );
      const onAdmin = nextEvent<LineUserEvent>(
        adminSocket,
        REALTIME_EVENTS.lineUserUpdated,
      );
      const onSuper = nextEvent<LineUserEvent>(
        superSocket,
        REALTIME_EVENTS.lineUserUpdated,
      );

      // A real mutation: session cookie (carried by the agent) AND the `x-csrf-token` header.
      const res = await admin.agent
        .patch(url(`/line-users/${lineUserId}`))
        .set('x-csrf-token', admin.token)
        .send({ access: AppAccess.ALLOWED })
        .expect(200);

      const [adminPayload, superPayload] = await Promise.all([
        onAdmin,
        onSuper,
      ]);

      // The payload is the row, not a notification: byte-identical to the PATCH's own response.
      expect(adminPayload).toEqual(res.body);
      expect(adminPayload.id).toBe(lineUserId);
      expect(adminPayload.lineUserId).toBe(`${LU_PREFIX}subject`);
      expect(adminPayload.access).toBe(AppAccess.ALLOWED);
      expect(adminPayload.registration).toBeNull();

      // X2: every admin in the namespace gets it — there are no rooms.
      expect(superPayload).toEqual(adminPayload);

      // AC-B13: the exact key set, so nothing that is not on the DTO can ever reach the wire.
      expect(Object.keys(adminPayload).sort()).toEqual(LINE_USER_DTO_KEYS);
      const serialised = JSON.stringify(adminPayload);
      expect(serialised).not.toContain('deletedAt');
      expect(serialised).not.toContain('rejectionReason');
      expect(serialised).not.toContain('language');

      // Exactly one — a re-emit would duplicate rows in the operator's table.
      await settle();
      expect(seenByAdmin).toHaveLength(1);
    });

    it('a failed mutation (404) emits nothing', async () => {
      const admin = await login(ADMIN);
      const socket = connectSocket({ cookie: admin.cookie });
      await waitForConnect(socket);

      const events: unknown[] = [];
      for (const event of Object.values(REALTIME_EVENTS)) {
        socket.on(event, (payload: unknown) => events.push(payload));
      }

      await admin.agent
        .patch(url('/line-users/never-existed'))
        .set('x-csrf-token', admin.token)
        .send({ access: AppAccess.ALLOWED })
        .expect(404);

      await settle();
      expect(events).toEqual([]);
    });
  });

  // ───────────────────── AC-B12: the revocation window ─────────────────────

  /**
   * **The reason this suite exists.** A socket has no next request, so `SessionGuard`'s
   * re-read-per-request model cannot cover it. Each case below proves over a REAL socket that the
   * revalidation sweep closes it — the DB paths through step 3, and logout through step 2, which is
   * the branch a DB-only check would miss entirely (logout destroys the Redis key while leaving the
   * `SystemUser` row perfectly valid).
   */
  describe('AC-B12 — a revoked admin is cut off within the sweep window', () => {
    const dbRevocations: Array<[string, Record<string, unknown>]> = [
      ['deletion (deletedAt)', { deletedAt: new Date() }],
      ['suspension (isActive: false)', { isActive: false }],
      ['demotion (role: STAFF)', { role: SystemRole.STAFF }],
      ['forced reset (mustChangePassword)', { mustChangePassword: true }],
    ];

    it.each(dbRevocations)(
      '%s closes the live socket with session.closed { REVOKED }',
      async (name, data) => {
        const { cookie } = await login(ADMIN);
        const socket = connectSocket({ cookie });
        await waitForConnect(socket);

        // Registered BEFORE the revoking write, so the assertion can never race the sweep.
        const closed = nextEvent<{ reason: string }>(
          socket,
          REALTIME_EVENTS.sessionClosed,
        );
        const disconnected = nextEvent<string>(socket, 'disconnect');

        const startedAt = Date.now();
        await prisma.systemUser.update({ where: { email: ADMIN }, data });

        const payload = await closed;
        await disconnected;
        const elapsedMs = Date.now() - startedAt;
        revocationTimings.push([name, elapsedMs]);

        expect(payload).toEqual({ reason: SESSION_CLOSED_REASONS.revoked });
        expect(socket.connected).toBe(false);
        expect(elapsedMs).toBeLessThan(REVOCATION_BUDGET_MS);
      },
    );

    it('explicit logout closes the live socket — the session-store branch a DB-only check would miss', async () => {
      const { agent, token, cookie } = await login(ADMIN);
      const socket = connectSocket({ cookie });
      await waitForConnect(socket);

      const closed = nextEvent<{ reason: string }>(
        socket,
        REALTIME_EVENTS.sessionClosed,
      );
      const disconnected = nextEvent<string>(socket, 'disconnect');

      const startedAt = Date.now();
      await agent
        .post(url('/auth/system/logout'))
        .set('x-csrf-token', token)
        .expect(200);

      const payload = await closed;
      await disconnected;
      const elapsedMs = Date.now() - startedAt;
      revocationTimings.push(['explicit logout', elapsedMs]);

      // The `SystemUser` row is still live, active, ADMIN and un-gated — only the Redis key is gone.
      const row = await prisma.systemUser.findUnique({
        where: { email: ADMIN },
        select: { isActive: true, deletedAt: true, role: true },
      });
      expect(row).toEqual({
        isActive: true,
        deletedAt: null,
        role: SystemRole.ADMIN,
      });

      expect(payload).toEqual({ reason: SESSION_CLOSED_REASONS.revoked });
      expect(socket.connected).toBe(false);
      expect(elapsedMs).toBeLessThan(REVOCATION_BUDGET_MS);
    });

    it('a healthy admin is never swept, and keeps receiving events across several sweep periods', async () => {
      const admin = await login(ADMIN);
      const socket = connectSocket({ cookie: admin.cookie });
      await waitForConnect(socket);

      const closes: unknown[] = [];
      socket.on(REALTIME_EVENTS.sessionClosed, (p: unknown) => closes.push(p));

      // Four sweep periods at 500 ms — the only false-positive detector that matters here.
      await settle(2_000);
      expect(closes).toEqual([]);
      expect(socket.connected).toBe(true);

      const updated = nextEvent<LineUserEvent>(
        socket,
        REALTIME_EVENTS.lineUserUpdated,
      );
      await admin.agent
        .patch(url(`/line-users/${lineUserId}`))
        .set('x-csrf-token', admin.token)
        .send({ access: AppAccess.BLOCKED })
        .expect(200);
      expect((await updated).access).toBe(AppAccess.BLOCKED);
    });
  });
});
