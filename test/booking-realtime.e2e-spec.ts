import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingStatus, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { AUTO_REJECTED_REASON } from '../src/bookings/bookings.constants';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  REALTIME_ADMIN_NAMESPACE,
  REALTIME_EVENTS,
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

const SU_PREFIX = 'e2e-brrt-su-';
const ROW_PREFIX = 'e2e-brrt-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const OBSERVER = `${SU_PREFIX}observer@easybook.local`;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const url = (path: string) => `${API_BASE_PATH}${path}`;

/** Exactly `AdminBookingRequestListItemDto`'s keys — the wire contract, asserted on the socket. */
const LIST_ITEM_KEYS = [
  'attendees',
  'code',
  'createdAt',
  'firstStartAt',
  'id',
  'isExpired',
  'lastEndAt',
  'origin',
  'purpose',
  'rejectReason',
  'requester',
  'slots',
  'status',
  'venue',
].sort();

interface BookingEvent {
  booking: {
    id: string;
    code: string;
    status: BookingStatus;
    rejectReason: string | null;
    requester: { name: string | null };
    venue: { id: string; name: string };
  };
  actor: { id: string; name: string } | null;
}

/**
 * `ADMIN-REALTIME-BOOKINGS-1` — a real HTTP decision reaching a real socket.
 *
 * 🔴 THE ASSERTION THIS SUITE EXISTS FOR: approving a request that ADR-001 auto-rejects two
 * overlapping pending requests must deliver **three** `bookingRequest.updated` events, not one. The
 * two losers are rows on other operators' screens and they changed; the unit specs prove the service
 * asks for three emits, and only this suite proves three arrive over the wire.
 *
 * ⚠️ IT LISTENS ON A REAL PORT (`app.listen`), unlike `booking-requests.e2e-spec.ts`. Socket.IO
 * attaches to the HTTP server at `init`, but nothing can connect to it until that server is
 * LISTENING — same reason `realtime.e2e-spec.ts` calls `listen(0)`.
 */
describe('Booking requests — realtime (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let baseUrl: string;
  let cookieName: string;
  let passwordHash: string;

  let venueId = '';
  let codeSeq = 0;

  const openSockets: Socket[] = [];
  const server = () => app.getHttpServer();

  // ───────────────────────────── helpers ─────────────────────────────

  interface Session {
    agent: request.Agent;
    token: string;
    cookie: string;
    id: string;
  }

  const staffIds: Record<string, string> = {};

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
    return { agent, token, cookie: raw.split(';')[0], id: staffIds[email] };
  };

  /**
   * `forceNew` is NOT optional: socket.io-client caches one `Manager` per origin, so a second socket
   * would otherwise reuse the first one's engine connection — and its `Cookie` header.
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

  /** The ONLY fixed wait here, and only ever to prove an ABSENCE (no fourth event). */
  const settle = (ms = 400): Promise<void> =>
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
  };

  /**
   * A PENDING request written straight to the database — the state the LIFF route produces and this
   * screen must resolve. Three of these overlap on purpose: a PENDING request holds nothing, so the
   * exclusion constraint does not object (`D-C13` rule 4).
   */
  const seedPending = async (
    span: [number, number],
    requesterName: string,
  ): Promise<{ id: string; code: string }> => {
    const start = new Date(Date.now() + span[0]);
    const end = new Date(Date.now() + span[1]);
    return prisma.bookingRequest.create({
      data: {
        code: `${ROW_PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        venueId,
        requesterName,
        contactPhone: '02-000-0000',
        purpose: 'ประชุมเตรียมงาน',
        attendees: 12,
        status: BookingStatus.PENDING,
        // A staff-typed request: `createdById` satisfies `booking_requests_owner_check` without a
        // LINE account, and keeps this suite free of LIFF fixtures.
        createdById: staffIds[ADMIN],
        firstStartAt: start,
        lastEndAt: end,
        slots: { create: [{ venueId, startAt: start, endAt: end }] },
      },
      select: { id: true, code: true },
    });
  };

  const seed = async () => {
    // 🔴 BOOKINGS BEFORE STAFF, ALWAYS: `createdById` is `onDelete: SetNull`, and a row with neither
    // owner violates `booking_requests_owner_check`.
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

    const base = {
      passwordHash,
      mustChangePassword: false,
      ...(await ensureE2eOptions(prisma)),
    };
    for (const [email, first] of [
      [ADMIN, 'วีระ'],
      [OBSERVER, 'มานี'],
    ] as Array<[string, string]>) {
      const row = await prisma.systemUser.create({
        data: {
          email,
          firstName: first,
          lastName: 'ทองดี',
          role: SystemRole.ADMIN,
          ...base,
        },
        select: { id: true },
      });
      staffIds[email] = row.id;
    }
  };

  // ───────────────────────────── lifecycle ─────────────────────────────

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    cookieName = sessionCookieName(app.get(ConfigService));
    await waitForRedis(redis);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    passwordHash = await new PasswordService().hash(PASSWORD);
  }, 60_000);

  beforeEach(async () => {
    await clearThrottleCounters(redis);
    await seed();
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
    await purgeRows();
    await purgeE2eUsers(prisma, SU_PREFIX);
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────

  /**
   * 🔴 THE CENTRAL ASSERTION. One operator approves; a SECOND operator's socket — a different
   * session entirely — receives three events, because ADR-001 changed three rows.
   */
  it('an approval that auto-rejects two overlapping requests delivers THREE bookingRequest.updated events', async () => {
    const admin = await login(ADMIN);
    const observer = await login(OBSERVER);
    const socket = connectSocket(observer.cookie);
    await waitForConnect(socket);

    const subject = await seedPending([DAY, DAY + 2 * HOUR], 'ผู้ชนะ');
    const loserA = await seedPending([DAY + HOUR, DAY + 3 * HOUR], 'ผู้แพ้ ก');
    const loserB = await seedPending(
      [DAY + 30 * 60_000, DAY + 90 * 60_000],
      'ผู้แพ้ ข',
    );

    const seen: BookingEvent[] = [];
    socket.on(REALTIME_EVENTS.bookingRequestUpdated, (p: BookingEvent) =>
      seen.push(p),
    );
    const created: BookingEvent[] = [];
    socket.on(REALTIME_EVENTS.bookingRequestCreated, (p: BookingEvent) =>
      created.push(p),
    );

    const res = await admin.agent
      .post(url(`/booking-requests/${subject.id}/approve`))
      .set('x-csrf-token', admin.token)
      .expect(200);
    expect(
      (res.body as { autoRejected: { id: string }[] }).autoRejected,
    ).toHaveLength(2);

    await waitUntil(() => seen.length >= 3, 'three bookingRequest.updated');
    // No fourth, and no `created` — an approval creates nothing.
    await settle();
    expect(seen).toHaveLength(3);
    expect(created).toHaveLength(0);

    // The subject leads; both losers follow, each announced exactly ONCE.
    expect(seen[0].booking.id).toBe(subject.id);
    expect(
      seen
        .slice(1)
        .map((e) => e.booking.id)
        .sort(),
    ).toEqual([loserA.id, loserB.id].sort());
    expect(seen[0].booking.status).toBe(BookingStatus.APPROVED);
    for (const event of seen.slice(1)) {
      expect(event.booking.status).toBe(BookingStatus.REJECTED);
      // 🔴 AC-BR15 — the string the LOSER reads names nobody.
      expect(event.booking.rejectReason).toBe(AUTO_REJECTED_REASON);
    }
  });

  it('the payload is the queue row, and the actor is the operator — id and name only', async () => {
    const admin = await login(ADMIN);
    const observer = await login(OBSERVER);
    const socket = connectSocket(observer.cookie);
    await waitForConnect(socket);

    const subject = await seedPending([2 * DAY, 2 * DAY + HOUR], 'ผู้ขอ');
    const seen: BookingEvent[] = [];
    socket.on(REALTIME_EVENTS.bookingRequestUpdated, (p: BookingEvent) =>
      seen.push(p),
    );

    await admin.agent
      .post(url(`/booking-requests/${subject.id}/approve`))
      .set('x-csrf-token', admin.token)
      .expect(200);
    await waitUntil(() => seen.length >= 1, 'one bookingRequest.updated');

    // The exact key set: the generated client is typed from this shape, so a stray field (or a
    // missing one) is a contract break rather than a cosmetic difference.
    expect(Object.keys(seen[0].booking).sort()).toEqual(LIST_ITEM_KEYS);
    expect(seen[0].booking.venue.id).toBe(venueId);
    // Who just did that — by name, and NOT by role or email.
    expect(Object.keys(seen[0].actor ?? {}).sort()).toEqual(['id', 'name']);
    expect(seen[0].actor?.id).toBe(admin.id);
    expect(seen[0].actor?.name).toBe('วีระ ทองดี');
  });

  it('a direct booking announces itself as `created` and its loser as `updated`', async () => {
    const admin = await login(ADMIN);
    const observer = await login(OBSERVER);
    const socket = connectSocket(observer.cookie);
    await waitForConnect(socket);

    const loser = await seedPending([3 * DAY, 3 * DAY + 2 * HOUR], 'ผู้แพ้');
    const created: BookingEvent[] = [];
    const updated: BookingEvent[] = [];
    socket.on(REALTIME_EVENTS.bookingRequestCreated, (p: BookingEvent) =>
      created.push(p),
    );
    socket.on(REALTIME_EVENTS.bookingRequestUpdated, (p: BookingEvent) =>
      updated.push(p),
    );

    const res = await admin.agent
      .post(url('/booking-requests/direct'))
      .set('x-csrf-token', admin.token)
      .send({
        venueId,
        purpose: 'ล็อกห้องให้ผู้บริหาร',
        attendees: 10,
        slots: [
          {
            startAt: new Date(Date.now() + 3 * DAY + HOUR).toISOString(),
            endAt: new Date(Date.now() + 3 * DAY + 3 * HOUR).toISOString(),
          },
        ],
        requesterName: 'สพท.',
        contactPhone: '02-000-0000',
      })
      .expect(201);

    await waitUntil(
      () => created.length >= 1 && updated.length >= 1,
      'one created and one updated',
    );
    await settle();
    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(created[0].booking.id).toBe(
      (res.body as { booking: { id: string } }).booking.id,
    );
    expect(created[0].booking.status).toBe(BookingStatus.APPROVED);
    expect(updated[0].booking.id).toBe(loser.id);
    expect(updated[0].booking.status).toBe(BookingStatus.REJECTED);
  });

  it('rejecting and cancelling each announce exactly one row', async () => {
    const admin = await login(ADMIN);
    const observer = await login(OBSERVER);
    const socket = connectSocket(observer.cookie);
    await waitForConnect(socket);

    const toReject = await seedPending([4 * DAY, 4 * DAY + HOUR], 'ก');
    const toCancel = await seedPending([5 * DAY, 5 * DAY + HOUR], 'ข');

    const seen: BookingEvent[] = [];
    socket.on(REALTIME_EVENTS.bookingRequestUpdated, (p: BookingEvent) =>
      seen.push(p),
    );

    await admin.agent
      .post(url(`/booking-requests/${toReject.id}/reject`))
      .set('x-csrf-token', admin.token)
      .send({ reason: 'ห้องไม่ว่าง' })
      .expect(200);
    await waitUntil(() => seen.length >= 1, 'the reject event');

    // Approve then cancel — `cancel` only accepts an APPROVED booking.
    await admin.agent
      .post(url(`/booking-requests/${toCancel.id}/approve`))
      .set('x-csrf-token', admin.token)
      .expect(200);
    await waitUntil(() => seen.length >= 2, 'the approve event');

    await admin.agent
      .post(url(`/booking-requests/${toCancel.id}/cancel`))
      .set('x-csrf-token', admin.token)
      .send({ reason: 'ท่อน้ำแตก' })
      .expect(200);
    await waitUntil(() => seen.length >= 3, 'the cancel event');

    await settle();
    expect(seen).toHaveLength(3);
    expect(seen.map((e) => e.booking.status)).toEqual([
      BookingStatus.REJECTED,
      BookingStatus.APPROVED,
      BookingStatus.CANCELLED,
    ]);
  });

  /** A refused decision writes nothing, so it must announce nothing. */
  it('announces nothing when the decision is refused', async () => {
    const admin = await login(ADMIN);
    const observer = await login(OBSERVER);
    const socket = connectSocket(observer.cookie);
    await waitForConnect(socket);

    const booking = await seedPending([6 * DAY, 6 * DAY + HOUR], 'ค');
    await prisma.bookingRequest.update({
      where: { id: booking.id },
      data: { status: BookingStatus.CANCELLED },
    });

    const seen: BookingEvent[] = [];
    socket.on(REALTIME_EVENTS.bookingRequestUpdated, (p: BookingEvent) =>
      seen.push(p),
    );

    await admin.agent
      .post(url(`/booking-requests/${booking.id}/approve`))
      .set('x-csrf-token', admin.token)
      .expect(409);

    await settle();
    expect(seen).toHaveLength(0);
  });
});
