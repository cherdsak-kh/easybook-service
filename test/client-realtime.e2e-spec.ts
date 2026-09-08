/**
 * ⚠️ THIS WRITE MUST SIT PHYSICALLY ABOVE THE IMPORT BLOCK. `ConfigModule.forRoot()` runs at *import*
 * time of `../src/app.module` (pulled in via `./e2e-app`), so a `beforeAll` assignment would be too
 * late by construction — the same precedent as `line-registration.e2e-spec.ts` and
 * `realtime.e2e-spec.ts`. `??` so an explicit shell export still wins.
 */
process.env.LINE_LOGIN_CHANNEL_ID =
  process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppAccess, BookingStatus, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  CLIENT_REALTIME_EVENTS,
  CLIENT_REALTIME_MESSAGES,
  REALTIME_ADMIN_NAMESPACE,
  REALTIME_CLIENT_NAMESPACE,
  REALTIME_ERRORS,
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

jest.setTimeout(180_000);

const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;

const SU_PREFIX = 'e2e-crt-su-';
const ROW_PREFIX = 'e2e-crt-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const ADMIN = `${SU_PREFIX}admin@easybook.local`;

/** The LINE-side `U…` subs. ⚠️ NOT the cuids the rooms are keyed on — those are read back below. */
const SUB_A = `${ROW_PREFIX}Ualice`;
const SUB_B = `${ROW_PREFIX}Ubob`;
const SUB_BLOCKED = `${ROW_PREFIX}Ublocked`;
const SUB_STRANGER = `${ROW_PREFIX}Unobody`;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface BookingUpdatedEvent {
  id: string;
  code: string;
  status: BookingStatus;
  rejectReason: string | null;
}

/** engine.io-client surfaces an engine-level rejection as a transport error, not a namespace code. */
type TransportError = Error & { description?: unknown };

/**
 * `CLIENT-REALTIME-1` — the `/client` Socket.IO namespace, end to end.
 *
 * 🔴 THE ASSERTION THIS SUITE EXISTS FOR IS `D-C13`. Two REAL sockets, two REAL LINE identities, one
 * REAL approval: Alice's request is approved and Bob's overlapping one is auto-rejected by ADR-001,
 * and each socket must receive its OWN `client.bookingUpdated` and never the other's. A mock cannot
 * prove that — room membership is a property of the live server, so only a two-socket test over the
 * wire says anything about it.
 *
 * ⚠️ EVERY SOCKET IT OPENS IS TRACKED AND CLOSED IN `afterEach`. A leaked socket keeps an engine.io
 * session and its timers alive, which hangs `app.close()` and leaves an open handle in every
 * subsequent suite — the same failure mode `StorageModule`'s conditional cron registration avoids.
 */
describe('Client realtime gateway (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let baseUrl: string;
  let cookieName: string;
  let passwordHash: string;

  let venueId = '';
  let adminId = '';
  /** The cuids `user:<…>` rooms are keyed on, read back after seeding. */
  const cuid: Record<string, string> = {};
  let codeSeq = 0;

  const openSockets: Socket[] = [];
  const server = () => app.getHttpServer();

  // ───────────────────────────── helpers ─────────────────────────────

  /**
   * LINE's verify endpoint, stubbed: **the token IS the `sub`**.
   *
   * That inversion is what lets two sockets hold two different identities at the same moment, which
   * a module-level `currentSub` (the pattern in `line-registration.e2e-spec.ts`) cannot express. The
   * literal token `invalid` is rejected with a 400 so the "bad token" case exercises LINE's own 4xx
   * branch rather than a missing header.
   */
  const stubLineVerify = () =>
    jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      const body = init?.body;
      const token =
        body instanceof URLSearchParams ? (body.get('id_token') ?? '') : '';
      if (!token || token === 'invalid') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({}),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            iss: 'https://access.line.me',
            sub: token,
            aud: CHANNEL_ID,
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
      } as Response);
    });

  const login = async () => {
    const agent = request.agent(server());
    const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
    const token = (csrf.body as { csrfToken: string }).csrfToken;
    const res = await agent
      .post(url('/auth/system/login'))
      .set('x-csrf-token', token)
      .send({ email: ADMIN, password: PASSWORD })
      .expect(200);
    const raw = readCookie(res, cookieName);
    if (!raw) throw new Error(`Login set no ${cookieName} cookie.`);
    return { agent, token, cookie: raw.split(';')[0] };
  };

  /**
   * `forceNew` is NOT optional: socket.io-client caches one `Manager` per origin, so without it the
   * second socket would silently reuse the FIRST one's engine connection — and therefore the first
   * one's identity. Every assertion below would then pass for the wrong reason.
   */
  const connectClient = (opts: {
    token?: string;
    header?: string;
    namespace?: string;
  }): Socket => {
    const socket = io(
      `${baseUrl}${opts.namespace ?? REALTIME_CLIENT_NAMESPACE}`,
      {
        path: '/socket.io',
        forceNew: true,
        reconnection: false,
        auth: opts.token === undefined ? {} : { token: opts.token },
        extraHeaders:
          opts.header === undefined ? {} : { Authorization: opts.header },
      },
    );
    openSockets.push(socket);
    return socket;
  };

  const waitForConnect = (socket: Socket, timeoutMs = 8_000): Promise<void> =>
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

  const waitForConnectError = (
    socket: Socket,
    timeoutMs = 8_000,
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

  const waitUntil = async (
    predicate: () => boolean,
    what: string,
    timeoutMs = 6_000,
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
  const settle = (ms = 500): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** Raw SQL — the application never hard-deletes, and fixtures must not accumulate. */
  const purgeRows = async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_slots WHERE "bookingRequestId" IN (SELECT id FROM booking_requests WHERE code LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_requests WHERE code LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_slots WHERE "venueId" IN (SELECT id FROM venues WHERE name LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_requests WHERE "venueId" IN (SELECT id FROM venues WHERE name LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE name LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE name LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${ROW_PREFIX}%'`,
    );
  };

  /** A PENDING request owned by a LINE user — the state the LIFF route produces. */
  const seedPending = (
    lineUserId: string,
    span: [number, number],
  ): Promise<{ id: string; code: string }> => {
    const start = new Date(Date.now() + span[0]);
    const end = new Date(Date.now() + span[1]);
    return prisma.bookingRequest.create({
      data: {
        code: `${ROW_PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        venueId,
        // 🔴 THE cuid, not the `U…` sub — `BookingRequest.lineUserId` is an FK to `LineUser.id`
        // (`schema.prisma`), which is exactly what `user:<…>` rooms are keyed on.
        lineUserId,
        purpose: 'ประชุมเตรียมงาน',
        attendees: 12,
        status: BookingStatus.PENDING,
        firstStartAt: start,
        lastEndAt: end,
        slots: { create: [{ venueId, startAt: start, endAt: end }] },
      },
      select: { id: true, code: true },
    });
  };

  const seed = async () => {
    await purgeRows();
    await purgeE2eUsers(prisma, SU_PREFIX);
    codeSeq = 0;

    const typeId = (
      await prisma.venueType.create({
        data: { name: `${ROW_PREFIX}hall` },
        select: { id: true },
      })
    ).id;
    venueId = (
      await prisma.venue.create({
        data: { name: `${ROW_PREFIX}main`, venueTypeId: typeId, capacity: 100 },
        select: { id: true },
      })
    ).id;

    for (const [sub, access] of [
      [SUB_A, AppAccess.ALLOWED],
      [SUB_B, AppAccess.ALLOWED],
      [SUB_BLOCKED, AppAccess.BLOCKED],
    ] as Array<[string, AppAccess]>) {
      const row = await prisma.lineUser.create({
        data: { lineUserId: sub, displayName: sub, access },
        select: { id: true },
      });
      cuid[sub] = row.id;
    }

    adminId = (
      await prisma.systemUser.create({
        data: {
          email: ADMIN,
          firstName: 'วีระ',
          lastName: 'ทองดี',
          role: SystemRole.ADMIN,
          passwordHash,
          mustChangePassword: false,
          ...(await ensureE2eOptions(prisma)),
        },
        select: { id: true },
      })
    ).id;
  };

  // ───────────────────────────── lifecycle ─────────────────────────────

  beforeAll(async () => {
    stubLineVerify();
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    cookieName = sessionCookieName(app.get(ConfigService));
    await waitForRedis(redis);
    // Socket.IO attaches to the HTTP server at `init`, but nothing can connect until it LISTENS.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    passwordHash = await new PasswordService().hash(PASSWORD);
  }, 60_000);

  beforeEach(async () => {
    await clearThrottleCounters(redis);
    await seed();
  });

  afterEach(() => {
    while (openSockets.length > 0) {
      const socket = openSockets.pop();
      socket?.removeAllListeners();
      socket?.disconnect();
    }
  });

  afterAll(async () => {
    await purgeRows();
    await purgeE2eUsers(prisma, SU_PREFIX);
    await clearThrottleCounters(redis);
    jest.restoreAllMocks();
    await app.close();
  });

  // ───────────────────────────── handshake ─────────────────────────────

  describe('handshake', () => {
    it('an ALLOWED LINE user connects with the token on handshake.auth', async () => {
      const socket = connectClient({ token: SUB_A });

      await waitForConnect(socket);
      expect(socket.connected).toBe(true);
    });

    it('the Authorization: Bearer header works too — the same verifier, either carrier', async () => {
      const socket = connectClient({ header: `Bearer ${SUB_A}` });

      await waitForConnect(socket);
      expect(socket.connected).toBe(true);
    });

    it('no token at all is UNAUTHENTICATED, and no event is ever delivered', async () => {
      const socket = connectClient({});
      const events: unknown[] = [];
      for (const event of Object.values(CLIENT_REALTIME_EVENTS)) {
        socket.on(event, (payload: unknown) => events.push(payload));
      }

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
      expect(socket.connected).toBe(false);

      await settle();
      expect(events).toEqual([]);
    });

    it('a token LINE rejects is UNAUTHENTICATED', async () => {
      const socket = connectClient({ token: 'invalid' });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
    });

    it('a verified sub with no LineUser row is UNAUTHENTICATED', async () => {
      const socket = connectClient({ token: SUB_STRANGER });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
    });

    /** The row exists, so this is a 403's analogue — a different status CLASS, deliberately. */
    it('a BLOCKED LINE user is FORBIDDEN, not UNAUTHENTICATED', async () => {
      const socket = connectClient({ token: SUB_BLOCKED });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.forbidden);
      expect(socket.connected).toBe(false);
    });

    it('a soft-deleted (unfollowed) LINE user is UNAUTHENTICATED', async () => {
      await prisma.lineUser.update({
        where: { id: cuid[SUB_A] },
        data: { deletedAt: new Date() },
      });

      const error = await waitForConnectError(connectClient({ token: SUB_A }));
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
    });

    /** 🔴 The barrier `realtime.constants.ts` describes: a LINE token buys nothing on `/admin`. */
    it('a perfectly valid LINE token cannot connect to /admin', async () => {
      const socket = connectClient({
        token: SUB_A,
        namespace: REALTIME_ADMIN_NAMESPACE,
      });

      const error = await waitForConnectError(socket);
      expect(error.message).toBe(REALTIME_ERRORS.unauthenticated);
      expect(socket.connected).toBe(false);
    });
  });

  // ───────────────────────── the driving mutation ─────────────────────────

  /** A real HTTP decision, session cookie + CSRF header — never a service call from the test. */
  const approve = (
    admin: { agent: request.Agent; token: string },
    id: string,
  ) =>
    admin.agent
      .post(url(`/booking-requests/${id}/approve`))
      .set('x-csrf-token', admin.token)
      .expect(200);

  // ───────────────────────── venue subscriptions ─────────────────────────

  describe('venue:watch / venue:unwatch', () => {
    const watch = (socket: Socket, body: unknown): Promise<unknown> =>
      socket.emitWithAck(CLIENT_REALTIME_MESSAGES.venueWatch, body);

    it('acknowledges a valid subscription and refuses a malformed one', async () => {
      const socket = connectClient({ token: SUB_A });
      await waitForConnect(socket);

      await expect(watch(socket, { venueId })).resolves.toEqual({ ok: true });
      await expect(watch(socket, {})).resolves.toEqual({ ok: false });
      await expect(
        watch(socket, { venueId, room: 'user:someone-else' }),
      ).resolves.toEqual({ ok: false });
    });

    it('venue:unwatch stops the venue events without touching the user room', async () => {
      const admin = await login();
      const socket = connectClient({ token: SUB_A });
      await waitForConnect(socket);
      await watch(socket, { venueId });

      const venueEvents: unknown[] = [];
      socket.on(CLIENT_REALTIME_EVENTS.venueAvailabilityChanged, (p: unknown) =>
        venueEvents.push(p),
      );
      const mine: BookingUpdatedEvent[] = [];
      socket.on(
        CLIENT_REALTIME_EVENTS.bookingUpdated,
        (p: BookingUpdatedEvent) => mine.push(p),
      );

      await socket.emitWithAck(CLIENT_REALTIME_MESSAGES.venueUnwatch, {
        venueId,
      });

      const request1 = await seedPending(cuid[SUB_A], [DAY, DAY + HOUR]);
      await approve(admin, request1.id);

      // The user room is untouched, so the owner still hears about their own booking…
      await waitUntil(() => mine.length === 1, 'the owner’s bookingUpdated');
      // …while the venue room has been left.
      await settle();
      expect(venueEvents).toEqual([]);
    });
  });

  // ─────────────────────── D-C13: the two-socket assertion ───────────────────────

  /**
   * 🔴 THE CENTRAL ASSERTION (`D-C13`). One real approval, two real sockets, two real identities.
   *
   * Alice's request wins; ADR-001 auto-rejects Bob's overlapping one. Each socket must receive
   * exactly its own `client.bookingUpdated` — and Alice must never see Bob's code or his rejection
   * reason, nor he hers. A UI that chose not to render the other person's payload would not be a
   * privacy boundary; the room is.
   */
  it('each socket receives ONLY its own user room’s bookingUpdated — never the other’s', async () => {
    const admin = await login();
    const socketA = connectClient({ token: SUB_A });
    const socketB = connectClient({ token: SUB_B });
    await Promise.all([waitForConnect(socketA), waitForConnect(socketB)]);

    const seenByA: BookingUpdatedEvent[] = [];
    const seenByB: BookingUpdatedEvent[] = [];
    socketA.on(
      CLIENT_REALTIME_EVENTS.bookingUpdated,
      (p: BookingUpdatedEvent) => seenByA.push(p),
    );
    socketB.on(
      CLIENT_REALTIME_EVENTS.bookingUpdated,
      (p: BookingUpdatedEvent) => seenByB.push(p),
    );

    // Overlapping spans: a PENDING request holds nothing, so both may exist at once (`D-C13` rule 4).
    const alice = await seedPending(cuid[SUB_A], [DAY, DAY + 2 * HOUR]);
    const bob = await seedPending(cuid[SUB_B], [DAY + HOUR, DAY + 3 * HOUR]);

    const res = await approve(admin, alice.id);
    expect(
      (res.body as { autoRejected: Array<{ id: string }> }).autoRejected.map(
        (r) => r.id,
      ),
    ).toEqual([bob.id]);

    await waitUntil(
      () => seenByA.length === 1 && seenByB.length === 1,
      'one bookingUpdated on each socket',
    );
    // A fixed wait, because the assertion is an ABSENCE: nothing else may arrive.
    await settle();

    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]).toEqual({
      id: alice.id,
      code: alice.code,
      status: BookingStatus.APPROVED,
      rejectReason: null,
    });

    expect(seenByB).toHaveLength(1);
    expect(seenByB[0].id).toBe(bob.id);
    expect(seenByB[0].status).toBe(BookingStatus.REJECTED);
    expect(typeof seenByB[0].rejectReason).toBe('string');

    // 🔴 THE PRIVACY ASSERTION, spelled out both ways: neither payload mentions the other request.
    expect(JSON.stringify(seenByA)).not.toContain(bob.code);
    expect(JSON.stringify(seenByB)).not.toContain(alice.code);
  });

  it('bookingUpdated carries four fields and no requester, purpose or venue detail', async () => {
    const admin = await login();
    const socket = connectClient({ token: SUB_A });
    await waitForConnect(socket);

    const seen: BookingUpdatedEvent[] = [];
    socket.on(CLIENT_REALTIME_EVENTS.bookingUpdated, (p: BookingUpdatedEvent) =>
      seen.push(p),
    );

    const alice = await seedPending(cuid[SUB_A], [DAY, DAY + HOUR]);
    await approve(admin, alice.id);

    await waitUntil(() => seen.length === 1, 'bookingUpdated');
    expect(Object.keys(seen[0]).sort()).toEqual([
      'code',
      'id',
      'rejectReason',
      'status',
    ]);
    expect(JSON.stringify(seen[0])).not.toContain('ประชุมเตรียมงาน');
  });

  /**
   * `venue:<id>` is a SHARED room, so `D-C13` applies to its payload rather than to its membership:
   * whoever is watching may learn that availability moved, and nothing about whose booking moved it.
   */
  it('venueAvailabilityChanged reaches watchers only, carrying the venue id and nothing else', async () => {
    const admin = await login();
    const watcher = connectClient({ token: SUB_A });
    const bystander = connectClient({ token: SUB_B });
    await Promise.all([waitForConnect(watcher), waitForConnect(bystander)]);

    await watcher.emitWithAck(CLIENT_REALTIME_MESSAGES.venueWatch, { venueId });

    const seenByWatcher: unknown[] = [];
    const seenByBystander: unknown[] = [];
    watcher.on(CLIENT_REALTIME_EVENTS.venueAvailabilityChanged, (p: unknown) =>
      seenByWatcher.push(p),
    );
    bystander.on(
      CLIENT_REALTIME_EVENTS.venueAvailabilityChanged,
      (p: unknown) => seenByBystander.push(p),
    );

    const alice = await seedPending(cuid[SUB_A], [DAY, DAY + HOUR]);
    await approve(admin, alice.id);

    await waitUntil(
      () => seenByWatcher.length === 1,
      'venueAvailabilityChanged on the watcher',
    );
    await settle();

    expect(seenByWatcher[0]).toEqual({ venueId });
    expect(JSON.stringify(seenByWatcher[0])).not.toContain(alice.code);
    // The bystander never subscribed, so the shared room is not a broadcast channel.
    expect(seenByBystander).toEqual([]);
  });

  /**
   * 🔴 `schedule:all` holds EVERY connected end-user, which is precisely why the pulse must carry
   * nothing. `socket.on(event, handler)` receives no argument at all, so `payload` is `undefined`.
   */
  it('scheduleUpdated reaches every socket and carries NO payload', async () => {
    const admin = await login();
    const socketA = connectClient({ token: SUB_A });
    const socketB = connectClient({ token: SUB_B });
    await Promise.all([waitForConnect(socketA), waitForConnect(socketB)]);

    const pulsesA: unknown[] = [];
    const pulsesB: unknown[] = [];
    socketA.on(CLIENT_REALTIME_EVENTS.scheduleUpdated, (...args: unknown[]) =>
      pulsesA.push(args),
    );
    socketB.on(CLIENT_REALTIME_EVENTS.scheduleUpdated, (...args: unknown[]) =>
      pulsesB.push(args),
    );

    const alice = await seedPending(cuid[SUB_A], [DAY, DAY + HOUR]);
    await approve(admin, alice.id);

    await waitUntil(
      () => pulsesA.length === 1 && pulsesB.length === 1,
      'a schedule pulse on both sockets',
    );

    expect(pulsesA[0]).toEqual([]);
    expect(pulsesB[0]).toEqual([]);
  });

  /** A rejection never occupied the org-wide day view, so it must not pulse it. */
  it('a REJECTED decision moves the owner’s card but never the shared schedule room', async () => {
    const admin = await login();
    const socket = connectClient({ token: SUB_A });
    await waitForConnect(socket);

    const cards: BookingUpdatedEvent[] = [];
    const pulses: unknown[] = [];
    socket.on(CLIENT_REALTIME_EVENTS.bookingUpdated, (p: BookingUpdatedEvent) =>
      cards.push(p),
    );
    socket.on(CLIENT_REALTIME_EVENTS.scheduleUpdated, () => pulses.push(1));

    const alice = await seedPending(cuid[SUB_A], [DAY, DAY + HOUR]);
    await admin.agent
      .post(url(`/booking-requests/${alice.id}/reject`))
      .set('x-csrf-token', admin.token)
      .send({ reason: 'ห้องปิดปรับปรุง' })
      .expect(200);

    await waitUntil(() => cards.length === 1, 'the owner’s bookingUpdated');
    await settle();

    expect(cards[0].status).toBe(BookingStatus.REJECTED);
    expect(cards[0].rejectReason).toBe('ห้องปิดปรับปรุง');
    expect(pulses).toEqual([]);
  });

  // ───────── PENDING occupies a slot · a cancellation frees one (Phase 7c refinements) ─────────

  /**
   * A REAL LIFF submission: bearer token, no cookie, no CSRF header (the route is exempt because it
   * is cookieless). Not `seedPending` — the point of these two tests is the emit path an ENDPOINT
   * takes, and a direct Prisma insert emits nothing.
   */
  const submit = (sub: string, span: [number, number]) =>
    request(server())
      .post(url('/line-users/bookings'))
      .set('Authorization', `Bearer ${sub}`)
      .send({
        venueId,
        purpose: 'ประชุมเตรียมงาน',
        attendees: 12,
        slots: [
          {
            startAt: new Date(Date.now() + span[0]).toISOString(),
            endAt: new Date(Date.now() + span[1]).toISOString(),
          },
        ],
      })
      .expect(201);

  const withdraw = (sub: string, id: string) =>
    request(server())
      .patch(url(`/line-users/bookings/${id}/cancel`))
      .set('Authorization', `Bearer ${sub}`)
      .expect(200);

  /**
   * 🔴 THE COMPETING-WATCHER TEST. `OCCUPYING_STATUSES` is `[APPROVED, PENDING]`, so Alice's
   * submission takes that hour off the venue's calendar the moment it commits — and Bob, sitting on
   * `#/venue/:id`, must be told before he picks the same slot.
   *
   * ⚠️ THE ABSENCE IS THE OTHER HALF: `schedule:all` holds BOTH sockets and must stay silent. `#/home`
   * is approved-only, and a pulse there would announce to the whole organisation that an unapproved
   * request exists.
   */
  it('a PENDING submission moves a COMPETING watcher’s venue calendar and never the shared schedule', async () => {
    const submitter = connectClient({ token: SUB_A });
    const watcher = connectClient({ token: SUB_B });
    await Promise.all([waitForConnect(submitter), waitForConnect(watcher)]);
    await watcher.emitWithAck(CLIENT_REALTIME_MESSAGES.venueWatch, { venueId });

    const venueEvents: unknown[] = [];
    const pulses: unknown[] = [];
    const ownCards: BookingUpdatedEvent[] = [];
    watcher.on(CLIENT_REALTIME_EVENTS.venueAvailabilityChanged, (p: unknown) =>
      venueEvents.push(p),
    );
    watcher.on(CLIENT_REALTIME_EVENTS.scheduleUpdated, () => pulses.push(1));
    submitter.on(CLIENT_REALTIME_EVENTS.scheduleUpdated, () => pulses.push(1));
    submitter.on(
      CLIENT_REALTIME_EVENTS.bookingUpdated,
      (p: BookingUpdatedEvent) => ownCards.push(p),
    );

    const created = (await submit(SUB_A, [DAY, DAY + HOUR])).body as {
      id: string;
      code: string;
    };

    await waitUntil(
      () => venueEvents.length === 1,
      'the watcher’s venueAvailabilityChanged',
    );
    // A fixed wait, because what follows is an ABSENCE.
    await settle();

    expect(venueEvents).toEqual([{ venueId }]);
    // `D-C13`: the shared room learns THAT availability moved, never whose request moved it.
    expect(JSON.stringify(venueEvents[0])).not.toContain(created.code);
    // The submitter's own room carries the request; the shared schedule room carries nothing.
    expect(ownCards.map((c) => c.status)).toEqual([BookingStatus.PENDING]);
    expect(pulses).toEqual([]);
  });

  /**
   * Gap 2: a user cancelling from `#/bookings` used to move nobody's screen at all. The withdrawal
   * frees the hour for the watcher AND — because the row settles at `CANCELLED` — pulses the
   * schedule, which the submission itself did not.
   */
  it('a user’s own withdrawal frees the watcher’s calendar and pulses the schedule', async () => {
    const owner = connectClient({ token: SUB_A });
    const watcher = connectClient({ token: SUB_B });
    await Promise.all([waitForConnect(owner), waitForConnect(watcher)]);
    await watcher.emitWithAck(CLIENT_REALTIME_MESSAGES.venueWatch, { venueId });

    const venueEvents: unknown[] = [];
    const pulses: unknown[] = [];
    const cards: BookingUpdatedEvent[] = [];
    watcher.on(CLIENT_REALTIME_EVENTS.venueAvailabilityChanged, (p: unknown) =>
      venueEvents.push(p),
    );
    watcher.on(CLIENT_REALTIME_EVENTS.scheduleUpdated, () => pulses.push(1));
    owner.on(CLIENT_REALTIME_EVENTS.bookingUpdated, (p: BookingUpdatedEvent) =>
      cards.push(p),
    );

    const created = (await submit(SUB_A, [2 * DAY, 2 * DAY + HOUR])).body as {
      id: string;
    };
    await waitUntil(() => cards.length === 1, 'the submission’s own card');

    await withdraw(SUB_A, created.id);

    await waitUntil(() => cards.length === 2, 'the withdrawal’s card');
    await settle();

    expect(cards.map((c) => c.status)).toEqual([
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
    ]);
    // One from the submission, one from the withdrawal — the hour was taken, then given back.
    expect(venueEvents).toEqual([{ venueId }, { venueId }]);
    // 🔴 EXACTLY ONE PULSE, from the CANCELLED settle. The PENDING submission must not have pulsed.
    expect(pulses).toHaveLength(1);
  });

  /** A guard against a silent regression in the fixture wiring rather than in the gateway. */
  it('the admin who drove every decision above is a real, distinct SystemUser', () => {
    expect(adminId).toMatch(/\S/);
    expect(adminId).not.toBe(cuid[SUB_A]);
  });
});
