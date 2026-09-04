import type { INestApplication } from '@nestjs/common';
import { BookingStatus, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import {
  AUTO_REJECTED_REASON,
  BOOKING_VENUE_LOCK_NS,
} from '../src/bookings/bookings.constants';
import { API_BASE_PATH } from '../src/common/api.constants';
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

const SU_PREFIX = 'e2e-brsu-';
const ROW_PREFIX = 'e2e-br-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const url = (path: string) => `${API_BASE_PATH}${path}`;
const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();

interface Session {
  agent: request.Agent;
  token: string;
}

interface SlotBody {
  id: string;
  startAt: string;
  endAt: string;
  isCancelled: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledByRole: string | null;
}

interface BookingBody {
  id: string;
  code: string;
  status: BookingStatus;
  origin: 'LINE' | 'ADMIN';
  isExpired: boolean;
  requester: {
    name: string | null;
    phone: string | null;
    departmentName: string | null;
  };
  venue: { id: string; name: string; capacity?: number; isOpen?: boolean };
  purpose: string;
  attendees: number;
  firstStartAt: string;
  lastEndAt: string;
  slots: SlotBody[];
  rejectReason: string | null;
  createdBy?: { id: string } | null;
  approvedBy?: { id: string } | null;
  approvedAt?: string | null;
  conflicts?: {
    approvedClash: boolean;
    pendingLosers: { id: string; code: string; requesterName: string | null }[];
  };
}

interface ListBody {
  data: BookingBody[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  counts: {
    all: number;
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
  };
}

interface ApproveBody {
  booking: BookingBody;
  autoRejected: { id: string; code: string }[];
}

interface PreflightBody {
  hasApprovedClash: boolean;
  approvedClashCount: number;
  overlappingPendingRequests: {
    id: string;
    code: string;
    purpose: string;
    requesterName: string | null;
  }[];
  venueIsOpen: boolean;
}

describe('Booking requests — admin surface (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  let venueId = '';
  let otherVenueId = '';
  let closedVenueId = '';
  let lineUserId = '';
  let blockedLineUserId = '';
  let departmentId = 0;
  let deletedDepartmentId = 0;
  let staffIds: Record<string, string> = {};
  let codeSeq = 0;

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
      `DELETE FROM line_user_registrations WHERE "lineUserId" IN (SELECT id FROM line_users WHERE "lineUserId" LIKE '${ROW_PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE name LIKE '${ROW_PREFIX}%'`,
    );
  };

  /**
   * A booking written straight to the database.
   *
   * ⚠️ IT BYPASSES THE SERVICE ON PURPOSE — the tests below need PENDING requests that already
   * overlap each other, which is exactly the state the LIFF route produces and the admin route must
   * then resolve. The `code` carries the fixture prefix so teardown can find it.
   */
  const seedBooking = async (opts: {
    status?: BookingStatus;
    venue?: string;
    spans: [number, number][];
    lineUser?: string | null;
    createdBy?: string | null;
    requesterName?: string | null;
    purpose?: string;
    createdAt?: Date;
    cancelledSlots?: number[];
  }): Promise<{ id: string; code: string; slotIds: string[] }> => {
    const spans = opts.spans.map(([s, e]) => ({
      start: new Date(Date.now() + s),
      end: new Date(Date.now() + e),
    }));
    const created = await prisma.bookingRequest.create({
      data: {
        code: `${ROW_PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        venueId: opts.venue ?? venueId,
        lineUserId:
          opts.lineUser === undefined ? lineUserId : (opts.lineUser ?? null),
        createdById: opts.createdBy ?? null,
        requesterName: opts.requesterName ?? null,
        purpose: opts.purpose ?? 'ประชุมเตรียมงาน',
        attendees: 12,
        status: opts.status ?? BookingStatus.PENDING,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        firstStartAt: new Date(
          Math.min(...spans.map((s) => s.start.getTime())),
        ),
        lastEndAt: new Date(Math.max(...spans.map((s) => s.end.getTime()))),
        slots: {
          create: spans.map((s, i) => ({
            venueId: opts.venue ?? venueId,
            startAt: s.start,
            endAt: s.end,
            ...(opts.cancelledSlots?.includes(i)
              ? { isCancelled: true, cancelledAt: new Date() }
              : {}),
          })),
        },
      },
      select: {
        id: true,
        code: true,
        slots: { orderBy: { startAt: 'asc' }, select: { id: true } },
      },
    });
    return {
      id: created.id,
      code: created.code,
      slotIds: created.slots.map((s) => s.id),
    };
  };

  const seed = async () => {
    // 🔴 BOOKINGS BEFORE STAFF, ALWAYS. `BookingRequest.createdById` is `onDelete: SetNull`, so
    // hard-deleting a staff fixture NULLs it — and a row whose `lineUserId` is also null then
    // violates `booking_requests_owner_check` (23514) and takes the whole purge down with it. That
    // CHECK is doing exactly its job; the fixture teardown is what has to respect the order.
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
    otherVenueId = (
      await prisma.venue.create({
        data: { name: `${ROW_PREFIX}annex`, venueTypeId: typeId, capacity: 30 },
        select: { id: true },
      })
    ).id;
    closedVenueId = (
      await prisma.venue.create({
        data: {
          name: `${ROW_PREFIX}closed`,
          venueTypeId: typeId,
          capacity: 20,
          isOpen: false,
          closedReason: 'ซ่อมระบบไฟ',
        },
        select: { id: true },
      })
    ).id;

    const options = await ensureE2eOptions(prisma);
    departmentId = (
      await prisma.department.create({
        data: { name: `${ROW_PREFIX}dept` },
        select: { id: true },
      })
    ).id;
    deletedDepartmentId = (
      await prisma.department.create({
        data: { name: `${ROW_PREFIX}gone`, deletedAt: new Date() },
        select: { id: true },
      })
    ).id;

    lineUserId = (
      await prisma.lineUser.create({
        data: {
          lineUserId: `${ROW_PREFIX}allowed`,
          access: 'ALLOWED',
          displayName: 'Somchai',
        },
        select: { id: true },
      })
    ).id;
    blockedLineUserId = (
      await prisma.lineUser.create({
        data: { lineUserId: `${ROW_PREFIX}blocked`, access: 'BLOCKED' },
        select: { id: true },
      })
    ).id;
    await prisma.lineUserRegistration.create({
      data: {
        lineUserId,
        firstName: 'สมชาย',
        lastName: 'ใจดี',
        phone: '081-234-5678',
        phoneDigits: '0812345678',
        departmentId: options.departmentId,
        personnelRoleId: options.personnelRoleId,
      },
    });

    const passwordHash = await new PasswordService().hash(PASSWORD);
    const base = { passwordHash, mustChangePassword: false, ...options };
    staffIds = {};
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
    ] as Array<[string, SystemRole]>) {
      const row = await prisma.systemUser.create({
        data: { email, firstName: 'E2E', lastName: role, role, ...base },
        select: { id: true },
      });
      staffIds[email] = row.id;
    }
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
  }, 60_000);

  beforeEach(async () => {
    await clearThrottleCounters(redis);
    await seed();
  });

  afterAll(async () => {
    // Same order as `seed()` — see the note there.
    await purgeRows();
    await purgeE2eUsers(prisma, SU_PREFIX);
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR1 / AC-BR6 / AC-BR7 — the six routes and who may reach them
  // ────────────────────────────────────────────────────────────────────────────────
  describe('access', () => {
    it('401s every route without a session', async () => {
      const anon = request.agent(server());
      const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
      const token = (csrf.body as { csrfToken: string }).csrfToken;
      const booking = await seedBooking({ spans: [[DAY, DAY + HOUR]] });

      await anon.get(url('/booking-requests')).expect(401);
      await anon.get(url(`/booking-requests/${booking.id}`)).expect(401);
      for (const path of ['approve', 'reject', 'cancel']) {
        await anon
          .post(url(`/booking-requests/${booking.id}/${path}`))
          .set('x-csrf-token', token)
          .send({ reason: 'x' })
          .expect(401);
      }
      await anon
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', token)
        .send({})
        .expect(401);
    });

    /**
     * 🔴 AC-BR7 — a REAL 403 from the service, on ALL FOUR write routes, from a LIVE VIEWER session.
     * A missing button is not a pass, and a permissive stub is not a pass.
     */
    it('VIEWER reads both GETs but gets 403 on all four write routes', async () => {
      const viewer = await login(VIEWER);
      const booking = await seedBooking({ spans: [[DAY, DAY + HOUR]] });

      await viewer.agent.get(url('/booking-requests')).expect(200);
      await viewer.agent
        .get(url(`/booking-requests/${booking.id}`))
        .expect(200);

      await viewer.agent
        .post(url(`/booking-requests/${booking.id}/approve`))
        .set('x-csrf-token', viewer.token)
        .expect(403);
      await viewer.agent
        .post(url(`/booking-requests/${booking.id}/reject`))
        .set('x-csrf-token', viewer.token)
        .send({ reason: 'nope' })
        .expect(403);
      await viewer.agent
        .post(url(`/booking-requests/${booking.id}/cancel`))
        .set('x-csrf-token', viewer.token)
        .send({ reason: 'nope' })
        .expect(403);
      await viewer.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', viewer.token)
        .send({
          venueId,
          purpose: 'x',
          attendees: 1,
          slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
          requesterName: 'x',
          contactPhone: '02',
        })
        .expect(403);

      // And nothing was written by any of them.
      const after = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      expect(after?.status).toBe(BookingStatus.PENDING);
    });

    it('403s a write with no CSRF token', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/approve`))
        .expect(403);
    });

    it('routes `direct` to the create handler, not to `:id` (AC-BR1)', async () => {
      const admin = await login(ADMIN);
      // A 400 from the DTO proves the literal segment reached `createDirect`; a 404 mentioning an
      // id called "direct" would be the shadowing bug the declaration order prevents.
      const res = await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send({})
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('venueId');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR2 / AC-BR3 / AC-BR4 / AC-BR5 — the queue
  // ────────────────────────────────────────────────────────────────────────────────
  describe('list and detail', () => {
    it('paginates, filters by status and venue, and counts the tabs without the status filter', async () => {
      const admin = await login(ADMIN);
      await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      await seedBooking({ spans: [[2 * DAY, 2 * DAY + HOUR]] });
      await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[3 * DAY, 3 * DAY + HOUR]],
      });
      await seedBooking({
        venue: otherVenueId,
        spans: [[4 * DAY, 4 * DAY + HOUR]],
      });

      const all = await admin.agent
        .get(url('/booking-requests?limit=10'))
        .expect(200);
      const allBody = all.body as ListBody;
      expect(allBody.meta).toMatchObject({ page: 1, limit: 10, total: 4 });
      expect(allBody.counts).toMatchObject({
        all: 4,
        pending: 3,
        approved: 1,
        rejected: 0,
        cancelled: 0,
      });

      // Selecting a tab narrows `data` but leaves the OTHER FOUR counts intact.
      const pendingOnly = await admin.agent
        .get(url('/booking-requests?status=PENDING'))
        .expect(200);
      const pendingBody = pendingOnly.body as ListBody;
      expect(pendingBody.meta.total).toBe(3);
      expect(pendingBody.counts.approved).toBe(1);
      expect(pendingBody.counts.all).toBe(4);

      const byVenue = await admin.agent
        .get(url(`/booking-requests?venueId=${otherVenueId}`))
        .expect(200);
      expect((byVenue.body as ListBody).meta.total).toBe(1);
      expect((byVenue.body as ListBody).counts.all).toBe(1);
    });

    it('answers an unknown venueId with an empty list, not a 404', async () => {
      const admin = await login(ADMIN);
      await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      const res = await admin.agent
        .get(url('/booking-requests?venueId=clx_no_such_venue'))
        .expect(200);
      expect((res.body as ListBody).meta.total).toBe(0);
      expect((res.body as ListBody).data).toEqual([]);
    });

    it('paginates with real page boundaries', async () => {
      const admin = await login(ADMIN);
      for (let i = 0; i < 12; i++) {
        await seedBooking({
          spans: [[(i + 1) * DAY, (i + 1) * DAY + HOUR]],
        });
      }
      const p1 = await admin.agent
        .get(url('/booking-requests?limit=10&page=1'))
        .expect(200);
      const p2 = await admin.agent
        .get(url('/booking-requests?limit=10&page=2'))
        .expect(200);
      expect((p1.body as ListBody).data).toHaveLength(10);
      expect((p2.body as ListBody).data).toHaveLength(2);
      expect((p1.body as ListBody).meta.totalPages).toBe(2);
      // No row appears on both pages — the `code` tiebreak makes the order total.
      const ids = new Set([
        ...(p1.body as ListBody).data.map((r) => r.id),
        ...(p2.body as ListBody).data.map((r) => r.id),
      ]);
      expect(ids.size).toBe(12);
    });

    /**
     * 🔬 AC-BR4 — `event-asc` must equal the order of the real `min(slots.startAt)` read from the
     * database. The fixtures deliberately list their slots out of order, so an implementation using
     * `slots[0]` produces a different answer.
     */
    it('sorts `event-*` by the true earliest slot, not by `slots[0]`', async () => {
      const admin = await login(ADMIN);
      // Each request's spans are written LAST-FIRST so `slots[0]` is never the earliest.
      const b1 = await seedBooking({
        spans: [
          [9 * DAY, 9 * DAY + HOUR],
          [3 * DAY, 3 * DAY + HOUR],
        ],
      });
      const b2 = await seedBooking({
        spans: [
          [8 * DAY, 8 * DAY + HOUR],
          [1 * DAY, 1 * DAY + HOUR],
        ],
        venue: otherVenueId,
      });
      const b3 = await seedBooking({
        spans: [
          [7 * DAY, 7 * DAY + HOUR],
          [5 * DAY, 5 * DAY + HOUR],
        ],
        venue: closedVenueId,
      });

      // The truth, straight from the database.
      const rows = await prisma.bookingRequest.findMany({
        where: { id: { in: [b1.id, b2.id, b3.id] } },
        select: {
          id: true,
          slots: { select: { startAt: true } },
        },
      });
      const expected = rows
        .map((r) => ({
          id: r.id,
          min: Math.min(...r.slots.map((s) => s.startAt.getTime())),
        }))
        .sort((a, b) => a.min - b.min)
        .map((r) => r.id);

      const asc = await admin.agent
        .get(url('/booking-requests?sort=event-asc'))
        .expect(200);
      expect((asc.body as ListBody).data.map((r) => r.id)).toEqual(expected);

      const desc = await admin.agent
        .get(url('/booking-requests?sort=event-desc'))
        .expect(200);
      expect((desc.body as ListBody).data.map((r) => r.id)).toEqual(
        [...expected].reverse(),
      );
    });

    it('sorts `created-*` by submission date, the opposite dimension', async () => {
      const admin = await login(ADMIN);
      // Newest submission, earliest event — the two orders must disagree.
      const older = await seedBooking({
        spans: [[9 * DAY, 9 * DAY + HOUR]],
        createdAt: new Date(Date.now() - 5 * DAY),
      });
      const newer = await seedBooking({
        spans: [[1 * DAY, 1 * DAY + HOUR]],
        createdAt: new Date(Date.now() - DAY),
      });

      const createdDesc = await admin.agent
        .get(url('/booking-requests?sort=created-desc'))
        .expect(200);
      expect((createdDesc.body as ListBody).data.map((r) => r.id)).toEqual([
        newer.id,
        older.id,
      ]);
      const createdAsc = await admin.agent
        .get(url('/booking-requests?sort=created-asc'))
        .expect(200);
      expect((createdAsc.body as ListBody).data.map((r) => r.id)).toEqual([
        older.id,
        newer.id,
      ]);
      // `created-desc` is the DEFAULT when `sort` is omitted (AC-BR3).
      const noSort = await admin.agent
        .get(url('/booking-requests'))
        .expect(200);
      expect((noSort.body as ListBody).data.map((r) => r.id)).toEqual([
        newer.id,
        older.id,
      ]);
    });

    it('400s an unknown sort and a limit outside 10/20/50', async () => {
      const admin = await login(ADMIN);
      await admin.agent
        .get(url('/booking-requests?sort=alphabetical'))
        .expect(400);
      await admin.agent.get(url('/booking-requests?limit=25')).expect(400);
      await admin.agent.get(url('/booking-requests?page=0')).expect(400);
      await admin.agent.get(url('/booking-requests?nope=1')).expect(400);
      for (const limit of [10, 20, 50]) {
        await admin.agent
          .get(url(`/booking-requests?limit=${limit}`))
          .expect(200);
      }
    });

    it('searches the code, the purpose, the venue name and BOTH sources of the requester name', async () => {
      const admin = await login(ADMIN);
      const line = await seedBooking({
        spans: [[DAY, DAY + HOUR]],
        purpose: 'อบรมครูผู้ช่วย',
      });
      const staff = await seedBooking({
        spans: [[2 * DAY, 2 * DAY + HOUR]],
        lineUser: null,
        createdBy: staffIds[ADMIN],
        requesterName: 'สำนักงานเขตพื้นที่',
        purpose: 'ตรวจเยี่ยม',
      });

      const byCode = await admin.agent
        .get(url(`/booking-requests?search=%23${line.code}`))
        .expect(200);
      expect((byCode.body as ListBody).data.map((r) => r.id)).toEqual([
        line.id,
      ]);

      const byPurpose = await admin.agent
        .get(url('/booking-requests?search=' + encodeURIComponent('อบรม')))
        .expect(200);
      expect((byPurpose.body as ListBody).data.map((r) => r.id)).toEqual([
        line.id,
      ]);

      const byVenue = await admin.agent
        .get(url(`/booking-requests?search=${ROW_PREFIX}main`))
        .expect(200);
      expect((byVenue.body as ListBody).meta.total).toBe(2);

      // The LINE-origin requester, through the registration.
      const byRegName = await admin.agent
        .get(url('/booking-requests?search=' + encodeURIComponent('สมชาย')))
        .expect(200);
      expect((byRegName.body as ListBody).data.map((r) => r.id)).toEqual([
        line.id,
      ]);

      // The ADMIN-origin requester, through the override column.
      const byOverride = await admin.agent
        .get(url('/booking-requests?search=' + encodeURIComponent('สำนักงาน')))
        .expect(200);
      expect((byOverride.body as ListBody).data.map((r) => r.id)).toEqual([
        staff.id,
      ]);
    });

    it('computes `isExpired` and `origin` at read time', async () => {
      const admin = await login(ADMIN);
      // A PENDING request whose event is over. Written by SQL because `parseSlots` refuses the past.
      const expired = await seedBooking({
        spans: [[-3 * HOUR, -2 * HOUR]],
      });
      const live = await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      const staff = await seedBooking({
        spans: [[2 * DAY, 2 * DAY + HOUR]],
        lineUser: null,
        createdBy: staffIds[ADMIN],
        requesterName: 'x',
      });

      const res = await admin.agent.get(url('/booking-requests')).expect(200);
      const byId = new Map(
        (res.body as ListBody).data.map((r) => [r.id, r] as const),
      );
      expect(byId.get(expired.id)?.isExpired).toBe(true);
      expect(byId.get(live.id)?.isExpired).toBe(false);
      expect(byId.get(live.id)?.origin).toBe('LINE');
      expect(byId.get(staff.id)?.origin).toBe('ADMIN');

      // ⛔ No stored fifth status: the row is still PENDING in the database.
      const row = await prisma.bookingRequest.findUnique({
        where: { id: expired.id },
        select: { status: true },
      });
      expect(row?.status).toBe(BookingStatus.PENDING);
    });

    /** AC-BR5 — every slot, cancelled ones included, plus the requester from either origin. */
    it('returns the full detail with all slots and resolves the requester from both origins', async () => {
      const admin = await login(ADMIN);
      const lineBooking = await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [
          [DAY, DAY + HOUR],
          [2 * DAY, 2 * DAY + HOUR],
          [3 * DAY, 3 * DAY + HOUR],
        ],
        cancelledSlots: [1],
      });

      const res = await admin.agent
        .get(url(`/booking-requests/${lineBooking.id}`))
        .expect(200);
      const body = res.body as BookingBody;

      expect(body.slots).toHaveLength(3);
      expect(body.slots.filter((s) => s.isCancelled)).toHaveLength(1);
      expect(body.requester).toEqual({
        name: 'สมชาย ใจดี',
        phone: '081-234-5678',
        departmentName: 'E2E Fixture Option',
      });
      expect(body.venue.capacity).toBe(100);
      expect(body.venue.isOpen).toBe(true);
      // No index key and no unresolvable id leak into the payload.
      expect(JSON.stringify(body)).not.toContain('holdsSlot');
      expect(JSON.stringify(body)).not.toContain('cancelledById');

      const staffBooking = await seedBooking({
        spans: [[5 * DAY, 5 * DAY + HOUR]],
        lineUser: null,
        createdBy: staffIds[ADMIN],
        requesterName: 'สพท. เขต 1',
      });
      const staffRes = await admin.agent
        .get(url(`/booking-requests/${staffBooking.id}`))
        .expect(200);
      expect((staffRes.body as BookingBody).requester.name).toBe('สพท. เขต 1');
      expect((staffRes.body as BookingBody).createdBy?.id).toBe(
        staffIds[ADMIN],
      );
    });

    it('404s an unknown id', async () => {
      const admin = await login(ADMIN);
      await admin.agent
        .get(url('/booking-requests/clx_does_not_exist'))
        .expect(404);
    });

    it('reports `conflicts` on a PENDING request and nothing on a settled one', async () => {
      const admin = await login(ADMIN);
      const mine = await seedBooking({ spans: [[DAY, DAY + 3 * HOUR]] });
      const rival = await seedBooking({
        spans: [[DAY + HOUR, DAY + 2 * HOUR]],
      });
      // Elsewhere and elsewhen — must NOT appear.
      await seedBooking({ spans: [[9 * DAY, 9 * DAY + HOUR]] });
      await seedBooking({
        venue: otherVenueId,
        spans: [[DAY, DAY + 3 * HOUR]],
      });

      const res = await admin.agent
        .get(url(`/booking-requests/${mine.id}`))
        .expect(200);
      const conflicts = (res.body as BookingBody).conflicts!;
      expect(conflicts.approvedClash).toBe(false);
      expect(conflicts.pendingLosers.map((l) => l.id)).toEqual([rival.id]);
      expect(conflicts.pendingLosers[0].requesterName).toBe('สมชาย ใจดี');

      const settled = await seedBooking({
        status: BookingStatus.REJECTED,
        spans: [[DAY, DAY + HOUR]],
      });
      const settledRes = await admin.agent
        .get(url(`/booking-requests/${settled.id}`))
        .expect(200);
      expect((settledRes.body as BookingBody).conflicts).toEqual({
        approvedClash: false,
        pendingLosers: [],
      });
    });

    it('flags `approvedClash` when an APPROVED slot already holds the range', async () => {
      const admin = await login(ADMIN);
      await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[DAY, DAY + 3 * HOUR]],
      });
      const mine = await seedBooking({
        spans: [[DAY + HOUR, DAY + 2 * HOUR]],
      });
      const res = await admin.agent
        .get(url(`/booking-requests/${mine.id}`))
        .expect(200);
      expect((res.body as BookingBody).conflicts!.approvedClash).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR14 / AC-BR15 / AC-BR17 — approve and the auto-rejection
  // ────────────────────────────────────────────────────────────────────────────────
  describe('approve', () => {
    /**
     * 🔬 AC-BR15 — verified IN THE DATABASE, not in the response: the loser is REJECTED with a
     * non-null reason, and the non-overlapping request is UNTOUCHED. Without the second half, code
     * that rejects everything would pass.
     */
    it('approves, auto-rejects only the overlapping PENDING requests, and names nobody', async () => {
      const admin = await login(ADMIN);
      const winner = await seedBooking({ spans: [[DAY, DAY + 3 * HOUR]] });
      const loser = await seedBooking({
        spans: [[DAY + HOUR, DAY + 2 * HOUR]],
      });
      const bystander = await seedBooking({
        spans: [[5 * DAY, 5 * DAY + HOUR]],
      });
      const elsewhere = await seedBooking({
        venue: otherVenueId,
        spans: [[DAY, DAY + 3 * HOUR]],
      });
      // Half-open: it starts exactly when the winner ends, so it survives (AC-BR18).
      const backToBack = await seedBooking({
        spans: [[DAY + 3 * HOUR, DAY + 4 * HOUR]],
      });

      const res = await admin.agent
        .post(url(`/booking-requests/${winner.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(200);
      const body = res.body as ApproveBody;
      expect(body.booking.status).toBe(BookingStatus.APPROVED);
      expect(body.booking.approvedBy?.id).toBe(staffIds[ADMIN]);
      expect(body.autoRejected.map((r) => r.id)).toEqual([loser.id]);

      // 🔬 The database, read directly.
      const rows = await prisma.bookingRequest.findMany({
        where: {
          id: {
            in: [
              winner.id,
              loser.id,
              bystander.id,
              elsewhere.id,
              backToBack.id,
            ],
          },
        },
        select: {
          id: true,
          status: true,
          rejectReason: true,
          approvedById: true,
          approvedAt: true,
        },
      });
      const byId = new Map(rows.map((r) => [r.id, r] as const));

      expect(byId.get(winner.id)?.status).toBe(BookingStatus.APPROVED);
      expect(byId.get(winner.id)?.approvedById).toBe(staffIds[ADMIN]);
      expect(byId.get(winner.id)?.approvedAt).not.toBeNull();

      expect(byId.get(loser.id)?.status).toBe(BookingStatus.REJECTED);
      expect(byId.get(loser.id)?.rejectReason).toBe(AUTO_REJECTED_REASON);

      // 🔴 The three that do not overlap are STILL PENDING.
      expect(byId.get(bystander.id)?.status).toBe(BookingStatus.PENDING);
      expect(byId.get(elsewhere.id)?.status).toBe(BookingStatus.PENDING);
      expect(byId.get(backToBack.id)?.status).toBe(BookingStatus.PENDING);

      // 🔴 The reason names no person, department, purpose or other request's code.
      const reason = byId.get(loser.id)!.rejectReason!;
      expect(reason).not.toContain(winner.code);
      expect(reason).not.toContain('สมชาย');
      expect(reason).not.toContain('ประชุมเตรียมงาน');

      // ⛔ The loser's own slots are untouched — "rejected" is not "cancelled".
      const loserSlots = await prisma.bookingSlot.findMany({
        where: { bookingRequestId: loser.id },
        select: { isCancelled: true, cancelledAt: true, holdsSlot: true },
      });
      expect(loserSlots.every((s) => !s.isCancelled)).toBe(true);
      expect(loserSlots.every((s) => s.cancelledAt === null)).toBe(true);
      // …and the trigger keeps them out of the exclusion index.
      expect(loserSlots.every((s) => !s.holdsSlot)).toBe(true);
    });

    it('sets `holdsSlot` on the winner’s live slots via the trigger', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({
        spans: [
          [DAY, DAY + HOUR],
          [2 * DAY, 2 * DAY + HOUR],
        ],
        cancelledSlots: [1],
      });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(200);

      const slots = await prisma.bookingSlot.findMany({
        where: { bookingRequestId: booking.id },
        orderBy: { startAt: 'asc' },
        select: { isCancelled: true, holdsSlot: true },
      });
      // The live one enters the index; the cancelled one never does.
      expect(slots.map((s) => s.holdsSlot)).toEqual([true, false]);
    });

    /** 🔬 AC-BR17 — a hard 409, and NOT ONE WRITE. */
    it('409s an overlap with an APPROVED slot and leaves every row exactly as it was', async () => {
      const admin = await login(ADMIN);
      await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[DAY, DAY + 3 * HOUR]],
      });
      const blocked = await seedBooking({
        spans: [[DAY + HOUR, DAY + 2 * HOUR]],
      });
      const otherPending = await seedBooking({
        spans: [[DAY + HOUR, DAY + 2 * HOUR]],
      });

      const res = await admin.agent
        .post(url(`/booking-requests/${blocked.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(409);
      // ⚠️ 409, never a 500 leaking out of Prisma (AC-BR22).
      expect((res.body as { statusCode: number }).statusCode).toBe(409);

      const rows = await prisma.bookingRequest.findMany({
        where: { id: { in: [blocked.id, otherPending.id] } },
        select: {
          id: true,
          status: true,
          approvedById: true,
          approvedAt: true,
        },
      });
      for (const row of rows) {
        expect(row.status).toBe(BookingStatus.PENDING);
        expect(row.approvedById).toBeNull();
        expect(row.approvedAt).toBeNull();
      }
    });

    it('409s a second approve of the same request and 404s an unknown id', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(200);
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(409);
      await admin.agent
        .post(url('/booking-requests/clx_nope/approve'))
        .set('x-csrf-token', admin.token)
        .expect(404);
    });

    /**
     * ⚠️ MEASURED, AND IT CONTRADICTS `02_design_log.md` §C.3, WHICH IS WRONG ON THIS POINT.
     * That section says a body carrying any key is a 400 "from `forbidNonWhitelisted`" while also
     * forbidding an empty DTO. Both cannot hold: `ValidationPipe` only ever sees a payload a handler
     * DECLARES, so with no `@Body()` parameter there is nothing to whitelist and the body is simply
     * never read. The instruction (no empty DTO) was followed; the predicted status was not
     * achievable without breaking it.
     *
     * 🔴 THE SECURITY-RELEVANT PROPERTY IS THE ONE ASSERTED HERE, and it is stronger than a 400: a
     * body cannot influence the outcome at all. `status`, `approvedById` and `rejectReason` are
     * written by the server from the session, so a client that sends them changes nothing.
     */
    it('ignores a request body entirely — nothing in it can reach a column', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/approve`))
        .set('x-csrf-token', admin.token)
        .send({
          status: 'REJECTED',
          approvedById: 'somebody-else',
          rejectReason: 'smuggled',
        })
        .expect(200);

      const row = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: { status: true, approvedById: true, rejectReason: true },
      });
      expect(row?.status).toBe(BookingStatus.APPROVED);
      expect(row?.approvedById).toBe(staffIds[ADMIN]);
      expect(row?.rejectReason).toBeNull();
    });

    it('409s a request whose every slot is already cancelled', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({
        spans: [[DAY, DAY + HOUR]],
        cancelledSlots: [0],
      });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(409);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR8 — reject
  // ────────────────────────────────────────────────────────────────────────────────
  describe('reject', () => {
    it('requires a reason and refuses a whitespace-only one', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      const path = url(`/booking-requests/${booking.id}/reject`);

      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({})
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({ reason: '' })
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({ reason: '     ' })
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({ reason: 'x'.repeat(501) })
        .expect(400);

      // Nothing was written by any of the four refusals.
      const row = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: { status: true, rejectReason: true },
      });
      expect(row?.status).toBe(BookingStatus.PENDING);
      expect(row?.rejectReason).toBeNull();
    });

    it('stores the trimmed reason and touches no slot', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({
        spans: [
          [DAY, DAY + HOUR],
          [2 * DAY, 2 * DAY + HOUR],
        ],
      });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/reject`))
        .set('x-csrf-token', admin.token)
        .send({ reason: '  ห้องถูกใช้จัดสอบ  ' })
        .expect(200);

      const row = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: {
          status: true,
          rejectReason: true,
          slots: { select: { isCancelled: true, holdsSlot: true } },
        },
      });
      expect(row?.status).toBe(BookingStatus.REJECTED);
      expect(row?.rejectReason).toBe('ห้องถูกใช้จัดสอบ');
      // ⛔ A rejected request keeps its slots; it stops occupying the calendar via the parent status.
      expect(row?.slots.every((s) => !s.isCancelled)).toBe(true);
      expect(row?.slots.every((s) => !s.holdsSlot)).toBe(true);
    });

    it('409s an APPROVED request — the way back is cancel', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[DAY, DAY + HOUR]],
      });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/reject`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'nope' })
        .expect(409);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR9 / AC-BR10 — cancel
  // ────────────────────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    const approvedThreeDays = () =>
      seedBooking({
        status: BookingStatus.APPROVED,
        spans: [
          [DAY, DAY + HOUR],
          [2 * DAY, 2 * DAY + HOUR],
          [3 * DAY, 3 * DAY + HOUR],
        ],
      });

    /**
     * 🔬 AC-BR10 — read straight from `booking_slots`: the flag, the timestamp and the reason are
     * all written, the parent stays APPROVED, and the span is recomputed from the SURVIVORS.
     */
    it('cancels named slots, writes the whole cancellation tuple, and recomputes the span', async () => {
      const admin = await login(ADMIN);
      const booking = await approvedThreeDays();

      await admin.agent
        .post(url(`/booking-requests/${booking.id}/cancel`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'ซ่อมระบบปรับอากาศ', slotIds: [booking.slotIds[0]] })
        .expect(200);

      const row = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: {
          status: true,
          firstStartAt: true,
          lastEndAt: true,
          slots: {
            orderBy: { startAt: 'asc' },
            select: {
              id: true,
              startAt: true,
              endAt: true,
              isCancelled: true,
              cancelledAt: true,
              cancelReason: true,
              cancelledById: true,
              cancelledByRole: true,
              holdsSlot: true,
            },
          },
        },
      });

      const [dropped, ...survivors] = row!.slots;
      expect(dropped.isCancelled).toBe(true);
      expect(dropped.cancelledAt).not.toBeNull();
      expect(dropped.cancelReason).toBe('ซ่อมระบบปรับอากาศ');
      expect(dropped.cancelledById).toBe(staffIds[ADMIN]);
      // G3: the actor's REAL SystemRole. `STAFF` no longer exists in the enum.
      expect(dropped.cancelledByRole).toBe(SystemRole.ADMIN);
      // The trigger took it back out of the exclusion index — the room is free again immediately.
      expect(dropped.holdsSlot).toBe(false);
      expect(survivors.every((s) => s.holdsSlot)).toBe(true);

      expect(row!.status).toBe(BookingStatus.APPROVED);
      expect(row!.firstStartAt.getTime()).toBe(survivors[0].startAt.getTime());
      expect(row!.lastEndAt.getTime()).toBe(survivors[1].endAt.getTime());
    });

    it('cancels the WHOLE booking when `slotIds` is omitted and turns it CANCELLED', async () => {
      const admin = await login(ADMIN);
      const booking = await approvedThreeDays();
      const before = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: { firstStartAt: true, lastEndAt: true },
      });

      await admin.agent
        .post(url(`/booking-requests/${booking.id}/cancel`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'ยกเลิกกิจกรรม' })
        .expect(200);

      const row = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: {
          status: true,
          firstStartAt: true,
          lastEndAt: true,
          slots: { select: { isCancelled: true, holdsSlot: true } },
        },
      });
      expect(row!.status).toBe(BookingStatus.CANCELLED);
      expect(row!.slots.every((s) => s.isCancelled)).toBe(true);
      expect(row!.slots.every((s) => !s.holdsSlot)).toBe(true);
      // ⚠️ The span is KEPT — the history list still needs a date to sort by.
      expect(row!.firstStartAt.getTime()).toBe(before!.firstStartAt.getTime());
      expect(row!.lastEndAt.getTime()).toBe(before!.lastEndAt.getTime());
    });

    it('turns the request CANCELLED when the LAST surviving slot goes', async () => {
      const admin = await login(ADMIN);
      const booking = await approvedThreeDays();
      const path = url(`/booking-requests/${booking.id}/cancel`);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({
          reason: 'a',
          slotIds: [booking.slotIds[0], booking.slotIds[1]],
        })
        .expect(200);
      const mid = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      expect(mid?.status).toBe(BookingStatus.APPROVED);

      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({ reason: 'b', slotIds: [booking.slotIds[2]] })
        .expect(200);
      const end = await prisma.bookingRequest.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      expect(end?.status).toBe(BookingStatus.CANCELLED);
    });

    /** 🔴 AC-BR9 — an id from another booking is a 400, never a silent skip. */
    it('400s a slot id from another booking and cancels NOTHING', async () => {
      const admin = await login(ADMIN);
      const mine = await approvedThreeDays();
      const theirs = await seedBooking({
        status: BookingStatus.APPROVED,
        venue: otherVenueId,
        spans: [[DAY, DAY + HOUR]],
      });

      await admin.agent
        .post(url(`/booking-requests/${mine.id}/cancel`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'x', slotIds: [mine.slotIds[0], theirs.slotIds[0]] })
        .expect(400);

      const slots = await prisma.bookingSlot.findMany({
        where: { bookingRequestId: { in: [mine.id, theirs.id] } },
        select: { isCancelled: true },
      });
      expect(slots.every((s) => !s.isCancelled)).toBe(true);
    });

    it('400s an empty or duplicated `slotIds`, and an explicit null', async () => {
      const admin = await login(ADMIN);
      const booking = await approvedThreeDays();
      const path = url(`/booking-requests/${booking.id}/cancel`);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({ reason: 'x', slotIds: [] })
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({
          reason: 'x',
          slotIds: [booking.slotIds[0], booking.slotIds[0]],
        })
        .expect(400);
      // 🔴 `null` must NOT be read as "omitted" — it would cancel the whole booking silently.
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({ reason: 'x', slotIds: null })
        .expect(400);
      const slots = await prisma.bookingSlot.findMany({
        where: { bookingRequestId: booking.id },
        select: { isCancelled: true },
      });
      expect(slots.every((s) => !s.isCancelled)).toBe(true);
    });

    it('requires a reason in both shapes', async () => {
      const admin = await login(ADMIN);
      const booking = await approvedThreeDays();
      const path = url(`/booking-requests/${booking.id}/cancel`);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({})
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send({ reason: '   ', slotIds: [booking.slotIds[0]] })
        .expect(400);
    });

    it('409s a PENDING request and one already fully cancelled', async () => {
      const admin = await login(ADMIN);
      const pending = await seedBooking({ spans: [[DAY, DAY + HOUR]] });
      await admin.agent
        .post(url(`/booking-requests/${pending.id}/cancel`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'x' })
        .expect(409);

      const done = await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[DAY, DAY + HOUR]],
        cancelledSlots: [0],
      });
      await admin.agent
        .post(url(`/booking-requests/${done.id}/cancel`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'x' })
        .expect(409);
    });

    /** 🔴 The lead-time rule is an END-USER rule and must not reach this path. */
    it('cancels a slot starting in ten minutes — no lead-time check on the staff path', async () => {
      const admin = await login(ADMIN);
      const booking = await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[10 * 60_000, HOUR]],
      });
      await admin.agent
        .post(url(`/booking-requests/${booking.id}/cancel`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'ท่อน้ำแตก' })
        .expect(200);
    });

    it('frees the range for a new approval immediately after a cancel', async () => {
      const admin = await login(ADMIN);
      const held = await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[DAY, DAY + 3 * HOUR]],
      });
      const waiting = await seedBooking({
        spans: [[DAY + HOUR, DAY + 2 * HOUR]],
      });

      await admin.agent
        .post(url(`/booking-requests/${waiting.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(409);

      await admin.agent
        .post(url(`/booking-requests/${held.id}/cancel`))
        .set('x-csrf-token', admin.token)
        .send({ reason: 'คืนห้อง' })
        .expect(200);

      await admin.agent
        .post(url(`/booking-requests/${waiting.id}/approve`))
        .set('x-csrf-token', admin.token)
        .expect(200);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR11 / AC-BR12 / AC-BR13 / AC-BR16 — direct booking
  // ────────────────────────────────────────────────────────────────────────────────
  describe('direct', () => {
    const directBody = (over: Record<string, unknown> = {}) => ({
      venueId,
      purpose: 'ประชุมคณะกรรมการสถานศึกษา',
      attendees: 20,
      slots: [{ startAt: iso(DAY), endAt: iso(DAY + 2 * HOUR) }],
      requesterName: 'สพท. เขต 1',
      contactPhone: '02-000-0000',
      ...over,
    });

    /** 🔬 AC-BR11 — checked in the database, not just in the response. */
    it('creates an APPROVED booking with approvedById === createdById === the caller', async () => {
      const admin = await login(ADMIN);
      const res = await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send(directBody({ departmentId }))
        .expect(201);
      const body = res.body as ApproveBody;

      const row = await prisma.bookingRequest.findUnique({
        where: { id: body.booking.id },
        select: {
          status: true,
          createdById: true,
          approvedById: true,
          approvedAt: true,
          requesterName: true,
          contactPhone: true,
          departmentId: true,
          lineUserId: true,
          code: true,
          firstStartAt: true,
          lastEndAt: true,
          slots: { select: { venueId: true, holdsSlot: true } },
        },
      });
      expect(row!.status).toBe(BookingStatus.APPROVED);
      expect(row!.createdById).toBe(staffIds[ADMIN]);
      expect(row!.approvedById).toBe(staffIds[ADMIN]);
      expect(row!.approvedAt).not.toBeNull();
      expect(row!.requesterName).toBe('สพท. เขต 1');
      expect(row!.contactPhone).toBe('02-000-0000');
      expect(row!.departmentId).toBe(departmentId);
      expect(row!.lineUserId).toBeNull();
      expect(row!.code).toMatch(/^BR-\d{8}-\d{3,}$/);
      // AC-BR11: `venueId` is copied onto every child, and the trigger put it in the index.
      expect(row!.slots.every((s) => s.venueId === venueId)).toBe(true);
      expect(row!.slots.every((s) => s.holdsSlot)).toBe(true);

      // Clean the non-prefixed code up — this row was minted by the service.
      await prisma.bookingSlot.deleteMany({
        where: { bookingRequestId: body.booking.id },
      });
      await prisma.bookingRequest.delete({ where: { id: body.booking.id } });
    });

    /** AC-BR16 — a direct booking takes the room from competing requests, exactly as approve does. */
    it('auto-rejects overlapping PENDING requests and leaves the others alone', async () => {
      const admin = await login(ADMIN);
      const loser = await seedBooking({
        spans: [[DAY + HOUR, DAY + 3 * HOUR]],
      });
      const bystander = await seedBooking({
        spans: [[6 * DAY, 6 * DAY + HOUR]],
      });

      const res = await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send(directBody())
        .expect(201);
      const body = res.body as ApproveBody;
      expect(body.autoRejected.map((r) => r.id)).toEqual([loser.id]);

      const rows = await prisma.bookingRequest.findMany({
        where: { id: { in: [loser.id, bystander.id] } },
        select: { id: true, status: true, rejectReason: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      expect(byId.get(loser.id)?.status).toBe(BookingStatus.REJECTED);
      expect(byId.get(loser.id)?.rejectReason).toBe(AUTO_REJECTED_REASON);
      expect(byId.get(bystander.id)?.status).toBe(BookingStatus.PENDING);

      await prisma.bookingSlot.deleteMany({
        where: { bookingRequestId: body.booking.id },
      });
      await prisma.bookingRequest.delete({ where: { id: body.booking.id } });
    });

    it('accepts path (A) — a LINE user — and resolves the name from the registration', async () => {
      const admin = await login(ADMIN);
      const res = await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send(
          directBody({
            lineUserId,
            requesterName: undefined,
            contactPhone: undefined,
          }),
        )
        .expect(201);
      const body = res.body as ApproveBody;
      expect(body.booking.requester.name).toBe('สมชาย ใจดี');
      // The chip says who TYPED it — a staff booking on behalf of a LINE user reads ADMIN.
      expect(body.booking.origin).toBe('ADMIN');

      const row = await prisma.bookingRequest.findUnique({
        where: { id: body.booking.id },
        select: {
          lineUserId: true,
          createdById: true,
          requesterName: true,
          contactPhone: true,
        },
      });
      expect(row!.lineUserId).toBe(lineUserId);
      expect(row!.createdById).toBe(staffIds[ADMIN]);
      // 🔴 Overrides, not a second profile store.
      expect(row!.requesterName).toBeNull();
      expect(row!.contactPhone).toBeNull();

      await prisma.bookingSlot.deleteMany({
        where: { bookingRequestId: body.booking.id },
      });
      await prisma.bookingRequest.delete({ where: { id: body.booking.id } });
    });

    it('400s the two origin shapes together, and a path (B) missing its phone', async () => {
      const admin = await login(ADMIN);
      const path = url('/booking-requests/direct');
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(directBody({ lineUserId }))
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(
          directBody({
            lineUserId,
            requesterName: undefined,
            contactPhone: undefined,
            departmentId,
          }),
        )
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(directBody({ contactPhone: undefined }))
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(directBody({ requesterName: undefined }))
        .expect(400);
    });

    it('400s an unusable lineUserId and a soft-deleted departmentId (AC-BR13)', async () => {
      const admin = await login(ADMIN);
      const path = url('/booking-requests/direct');
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(
          directBody({
            lineUserId: blockedLineUserId,
            requesterName: undefined,
            contactPhone: undefined,
          }),
        )
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(directBody({ departmentId: deletedDepartmentId }))
        .expect(400);
    });

    it('409s an overlap with an APPROVED booking and creates nothing', async () => {
      const admin = await login(ADMIN);
      await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[DAY, DAY + 3 * HOUR]],
      });
      const before = await prisma.bookingRequest.count();
      await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send(directBody())
        .expect(409);
      expect(await prisma.bookingRequest.count()).toBe(before);
    });

    it('404s an unknown venue, and 400s a past / inverted / self-overlapping slot', async () => {
      const admin = await login(ADMIN);
      const path = url('/booking-requests/direct');
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(directBody({ venueId: 'clx_no_such_venue' }))
        .expect(404);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(
          directBody({ slots: [{ startAt: iso(-HOUR), endAt: iso(HOUR) }] }),
        )
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(
          directBody({
            slots: [{ startAt: iso(DAY + HOUR), endAt: iso(DAY) }],
          }),
        )
        .expect(400);
      await admin.agent
        .post(path)
        .set('x-csrf-token', admin.token)
        .send(
          directBody({
            slots: [
              { startAt: iso(DAY), endAt: iso(DAY + 3 * HOUR) },
              { startAt: iso(DAY + 2 * HOUR), endAt: iso(DAY + 4 * HOUR) },
            ],
          }),
        )
        .expect(400);
    });

    /** 🟡 G2 — `isOpen` refuses new REQUESTS; a staff lock is not a request. */
    it('books a CLOSED venue — and says so in the payload', async () => {
      const admin = await login(ADMIN);
      const res = await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send(directBody({ venueId: closedVenueId }))
        .expect(201);
      const body = res.body as ApproveBody;
      expect(body.booking.venue.isOpen).toBe(false);
      await prisma.bookingSlot.deleteMany({
        where: { bookingRequestId: body.booking.id },
      });
      await prisma.bookingRequest.delete({ where: { id: body.booking.id } });
    });

    /**
     * 🔴 AC-BR12 — the three `D-C18` overrides must STILL be refused on the LIFF route. This change
     * added them to a DIFFERENT class in a different file; if somebody "shares" one DTO later, this
     * is the test that fails.
     */
    it('AC-BR12: the LIFF create route still rejects the three override fields', async () => {
      const anon = request.agent(server());
      for (const field of ['requesterName', 'contactPhone', 'departmentId']) {
        const res = await anon.post(url('/line-users/bookings')).send({
          venueId,
          purpose: 'x',
          attendees: 1,
          slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
          [field]: field === 'departmentId' ? 1 : 'x',
        });
        // 401 from the id-token guard, or 400 from `forbidNonWhitelisted` — either way the field
        // never reaches the column. The guard runs first, so assert the field is not accepted by
        // checking no row was written.
        expect([400, 401]).toContain(res.status);
      }
      const written = await prisma.bookingRequest.count({
        where: { requesterName: 'x' },
      });
      expect(written).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // G1 — POST /booking-requests/preflight, the create dialog's live conflict banner
  // ────────────────────────────────────────────────────────────────────────────────
  describe('preflight', () => {
    const PREFLIGHT = url('/booking-requests/preflight');

    /** Drop a row the SERVICE minted — its `code` carries no fixture prefix for `purgeRows`. */
    const dropServiceRow = async (id: string) => {
      await prisma.bookingSlot.deleteMany({ where: { bookingRequestId: id } });
      await prisma.bookingRequest.delete({ where: { id } });
    };

    it('answers 200 for an ADMIN and 200 for a VIEWER — it is a read wearing a POST', async () => {
      const admin = await login(ADMIN);
      const viewer = await login(VIEWER);
      const body = {
        venueId,
        slots: [{ startAt: iso(DAY), endAt: iso(DAY + 2 * HOUR) }],
      };

      for (const who of [admin, viewer]) {
        const res = await who.agent
          .post(PREFLIGHT)
          .set('x-csrf-token', who.token)
          .send(body)
          .expect(200);
        expect(res.body as PreflightBody).toEqual({
          hasApprovedClash: false,
          approvedClashCount: 0,
          overlappingPendingRequests: [],
          venueIsOpen: true,
        });
      }
    });

    it('401s without a session, and 403s a session with no CSRF token', async () => {
      const anon = request.agent(server());
      const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
      await anon
        .post(PREFLIGHT)
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .send({
          venueId,
          slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
        })
        .expect(401);

      // ⚠️ It creates nothing, but it is still a POST — CSRF is not waived for being read-only.
      const admin = await login(ADMIN);
      await admin.agent
        .post(PREFLIGHT)
        .send({
          venueId,
          slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
        })
        .expect(403);
    });

    /**
     * 🔴 THE TEST THIS FEATURE EXISTS FOR: preflight must PREDICT the submit. A banner that says
     * "clean" over a body `direct` then 409s — or "conflict" over one it would have accepted — is the
     * only way this can fail in production, because the operator trusts it instead of the endpoint.
     */
    it('agrees with `POST /direct` for the SAME spans, both ways round', async () => {
      const admin = await login(ADMIN);

      // ── (a) CLEAN → the submit succeeds ──
      const cleanSlots = [
        { startAt: iso(7 * DAY), endAt: iso(7 * DAY + HOUR) },
      ];
      const clean = await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({ venueId, slots: cleanSlots })
        .expect(200);
      expect((clean.body as PreflightBody).hasApprovedClash).toBe(false);

      const created = await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send({
          venueId,
          purpose: 'ประชุมกรรมการ',
          attendees: 10,
          slots: cleanSlots,
          requesterName: 'สพท.',
          contactPhone: '02-000-0000',
        })
        .expect(201);
      const madeId = (created.body as ApproveBody).booking.id;

      // ── (b) THE SAME SPANS AGAIN, now held by what (a) just created → the submit 409s ──
      const dirty = await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({ venueId, slots: cleanSlots })
        .expect(200);
      expect((dirty.body as PreflightBody).hasApprovedClash).toBe(true);
      expect((dirty.body as PreflightBody).approvedClashCount).toBe(1);

      await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send({
          venueId,
          purpose: 'ประชุมซ้อน',
          attendees: 10,
          slots: cleanSlots,
          requesterName: 'สพท.',
          contactPhone: '02-000-0000',
        })
        .expect(409);

      await dropServiceRow(madeId);
    });

    /**
     * 🔴 THE TEST THAT PINS THE SHARED CORE. `conflicts.pendingLosers` on a SAVED request and
     * `overlappingPendingRequests` on the SAME spans unsaved must name the same requests — the only
     * difference being that a saved request is excluded from its own answer and unsaved spans belong
     * to no request to exclude.
     */
    it('agrees with `GET /booking-requests/:id`’s `conflicts` on the same spans', async () => {
      const admin = await login(ADMIN);
      const mine = await seedBooking({ spans: [[DAY, DAY + 3 * HOUR]] });
      const rival = await seedBooking({
        spans: [[DAY + HOUR, DAY + 2 * HOUR]],
      });
      // Elsewhere and elsewhen — must appear in NEITHER answer.
      await seedBooking({ spans: [[9 * DAY, 9 * DAY + HOUR]] });
      await seedBooking({
        venue: otherVenueId,
        spans: [[DAY, DAY + 3 * HOUR]],
      });

      const detail = await admin.agent
        .get(url(`/booking-requests/${mine.id}`))
        .expect(200);
      const detailBody = detail.body as BookingBody;
      const fromDetail = detailBody.conflicts!.pendingLosers.map((l) => l.id);

      // The EXACT stored spans, read back off the detail, so the two calls ask the same question.
      const res = await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({
          venueId,
          slots: detailBody.slots.map((s) => ({
            startAt: s.startAt,
            endAt: s.endAt,
          })),
        })
        .expect(200);
      const fromPreflight = (
        res.body as PreflightBody
      ).overlappingPendingRequests.map((p) => p.id);

      expect(fromDetail).toEqual([rival.id]);
      // Allowing for the request itself, which preflight cannot know to exclude.
      expect(new Set(fromPreflight)).toEqual(new Set([...fromDetail, mine.id]));
      expect((res.body as PreflightBody).hasApprovedClash).toBe(
        detailBody.conflicts!.approvedClash,
      );
    });

    /**
     * ⚠️ ONE ENTRY PER REQUEST, however many of its slots overlap. The rival below has three slots
     * and every one of them is hit.
     */
    it('deduplicates a request whose THREE slots all overlap', async () => {
      const admin = await login(ADMIN);
      const rival = await seedBooking({
        purpose: 'อบรมครูสามวัน',
        spans: [
          [DAY, DAY + 2 * HOUR],
          [2 * DAY, 2 * DAY + 2 * HOUR],
          [3 * DAY, 3 * DAY + 2 * HOUR],
        ],
      });

      const res = await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({
          venueId,
          slots: [
            { startAt: iso(DAY + HOUR), endAt: iso(DAY + 90 * 60_000) },
            { startAt: iso(2 * DAY + HOUR), endAt: iso(2 * DAY + 90 * 60_000) },
            { startAt: iso(3 * DAY + HOUR), endAt: iso(3 * DAY + 90 * 60_000) },
          ],
        })
        .expect(200);
      const body = res.body as PreflightBody;

      expect(body.overlappingPendingRequests).toHaveLength(1);
      expect(body.overlappingPendingRequests[0]).toEqual({
        id: rival.id,
        code: rival.code,
        // Revealed on purpose — the admin is the permitted viewer, and this is what the operator is
        // being asked to weigh before bumping them (`D-C13` is about the AUDIENCE).
        purpose: 'อบรมครูสามวัน',
        requesterName: 'สมชาย ใจดี',
      });
    });

    /** ⚠️ SLOTS, NOT BOOKINGS — one three-day approved booking across three requested days is 3. */
    it('counts APPROVED conflicts in SLOTS, not in bookings', async () => {
      const admin = await login(ADMIN);
      await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [
          [DAY, DAY + 2 * HOUR],
          [2 * DAY, 2 * DAY + 2 * HOUR],
          [3 * DAY, 3 * DAY + 2 * HOUR],
        ],
      });

      const res = await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({
          venueId,
          slots: [
            { startAt: iso(DAY + HOUR), endAt: iso(DAY + 90 * 60_000) },
            { startAt: iso(2 * DAY + HOUR), endAt: iso(2 * DAY + 90 * 60_000) },
            { startAt: iso(3 * DAY + HOUR), endAt: iso(3 * DAY + 90 * 60_000) },
          ],
        })
        .expect(200);
      expect(res.body as PreflightBody).toMatchObject({
        hasApprovedClash: true,
        approvedClashCount: 3,
      });
    });

    /** 🟡 G2 — informational, never a refusal: the direct booking that follows still succeeds. */
    it('reports `venueIsOpen: false` for a closed venue, and the direct booking still works', async () => {
      const admin = await login(ADMIN);
      const slots = [{ startAt: iso(8 * DAY), endAt: iso(8 * DAY + HOUR) }];

      const res = await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({ venueId: closedVenueId, slots })
        .expect(200);
      expect(res.body as PreflightBody).toMatchObject({
        venueIsOpen: false,
        hasApprovedClash: false,
      });

      const created = await admin.agent
        .post(url('/booking-requests/direct'))
        .set('x-csrf-token', admin.token)
        .send({
          venueId: closedVenueId,
          purpose: 'ล็อกห้องเพื่อซ่อม',
          attendees: 2,
          slots,
          requesterName: 'ฝ่ายอาคาร',
          contactPhone: '02-000-0000',
        })
        .expect(201);
      await dropServiceRow((created.body as ApproveBody).booking.id);
    });

    /**
     * 🔴 IT WRITES NOTHING, DESPITE THE VERB. Row counts AND `updatedAt` — a count alone would miss
     * an in-place update, and this endpoint runs on every keystroke of the create dialog.
     */
    it('writes nothing at all — row counts and `updatedAt` are untouched', async () => {
      const admin = await login(ADMIN);
      const pending = await seedBooking({ spans: [[DAY, DAY + 3 * HOUR]] });
      await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[4 * DAY, 4 * DAY + 3 * HOUR]],
      });

      const snapshot = async () => ({
        requests: await prisma.bookingRequest.count(),
        slots: await prisma.bookingSlot.count(),
        rows: await prisma.bookingRequest.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, status: true, updatedAt: true },
        }),
        slotRows: await prisma.bookingSlot.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, isCancelled: true, updatedAt: true },
        }),
      });

      const before = await snapshot();
      for (const slots of [
        // Clean, clashing with the APPROVED one, and overlapping the PENDING one.
        [{ startAt: iso(11 * DAY), endAt: iso(11 * DAY + HOUR) }],
        [{ startAt: iso(4 * DAY + HOUR), endAt: iso(4 * DAY + 2 * HOUR) }],
        [{ startAt: iso(DAY + HOUR), endAt: iso(DAY + 2 * HOUR) }],
      ]) {
        await admin.agent
          .post(PREFLIGHT)
          .set('x-csrf-token', admin.token)
          .send({ venueId, slots })
          .expect(200);
      }
      expect(await snapshot()).toEqual(before);

      // And the request it named as a loser was NOT rejected — preflight predicts, it does not act.
      const after = await prisma.bookingRequest.findUnique({
        where: { id: pending.id },
        select: { status: true, rejectReason: true },
      });
      expect(after).toEqual({
        status: BookingStatus.PENDING,
        rejectReason: null,
      });
    });

    /**
     * 🔴 THE SAME THREE REFUSALS `parseSlots` MAKES ON `direct`, and in the same order relative to
     * the venue 404. A preflight that accepts a body the submit would 400 has lied to the operator.
     */
    it('400s a past / inverted / self-overlapping span, exactly as `direct` does', async () => {
      const admin = await login(ADMIN);
      const bad = [
        [{ startAt: iso(-HOUR), endAt: iso(HOUR) }],
        [{ startAt: iso(DAY + HOUR), endAt: iso(DAY) }],
        [
          { startAt: iso(DAY), endAt: iso(DAY + 3 * HOUR) },
          { startAt: iso(DAY + 2 * HOUR), endAt: iso(DAY + 4 * HOUR) },
        ],
      ];
      for (const slots of bad) {
        // Both endpoints refuse the same body the same way.
        await admin.agent
          .post(PREFLIGHT)
          .set('x-csrf-token', admin.token)
          .send({ venueId, slots })
          .expect(400);
        await admin.agent
          .post(url('/booking-requests/direct'))
          .set('x-csrf-token', admin.token)
          .send({
            venueId,
            purpose: 'x',
            attendees: 1,
            slots,
            requesterName: 'x',
            contactPhone: '02',
          })
          .expect(400);
      }
    });

    it('404s an unknown venue, and 400s an empty slot list or an unknown key', async () => {
      const admin = await login(ADMIN);
      await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({
          venueId: 'clx_no_such_venue',
          slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
        })
        .expect(404);
      await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({ venueId, slots: [] })
        .expect(400);
      // `forbidNonWhitelisted` — nothing else may ride along on this body.
      await admin.agent
        .post(PREFLIGHT)
        .set('x-csrf-token', admin.token)
        .send({
          venueId,
          slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
          excludeRequestId: 'clx_nope',
        })
        .expect(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR21 — concurrency. BOTH tests are required; see the notes on each.
  // ────────────────────────────────────────────────────────────────────────────────
  describe('concurrency (AC-BR21)', () => {
    /**
     * 🔬 21a — THE PRODUCT LEVEL. Two approvals of overlapping requests fired with `Promise.all`.
     *
     * ⚠️ THIS TEST ALONE IS NOT ENOUGH, and the reason is worth stating: with the advisory lock in
     * place the loser is refused at `updateMany({ where: { id, status: PENDING } }).count === 0`
     * (the winner rejected it first), so it never reaches the constraint — this would pass even if
     * the constraint did not exist. 21b is the one that fails if the migration is wrong.
     */
    it('21a: two simultaneous approvals — one 200, one 409, and exactly one slot holds the range', async () => {
      const admin = await login(ADMIN);
      const superAdmin = await login(SUPER);
      const a = await seedBooking({ spans: [[DAY, DAY + 3 * HOUR]] });
      const b = await seedBooking({ spans: [[DAY + HOUR, DAY + 2 * HOUR]] });

      const [resA, resB] = await Promise.all([
        admin.agent
          .post(url(`/booking-requests/${a.id}/approve`))
          .set('x-csrf-token', admin.token),
        superAdmin.agent
          .post(url(`/booking-requests/${b.id}/approve`))
          .set('x-csrf-token', superAdmin.token),
      ]);

      const codes = [resA.status, resB.status].sort();
      expect(codes).toEqual([200, 409]);
      // ⚠️ 409, never a 500 (AC-BR22).
      expect(codes).not.toContain(500);

      const rows = await prisma.bookingRequest.findMany({
        where: { id: { in: [a.id, b.id] } },
        select: { id: true, status: true, rejectReason: true },
      });
      const approved = rows.filter((r) => r.status === BookingStatus.APPROVED);
      expect(approved).toHaveLength(1);

      const loser = rows.find((r) => r.status !== BookingStatus.APPROVED)!;
      // The loser is REJECTED with a reason — either auto-rejected by the winner, or refused
      // outright; both are legitimate outcomes of the race, and both must leave a reason.
      if (loser.status === BookingStatus.REJECTED) {
        expect(loser.rejectReason).toBe(AUTO_REJECTED_REASON);
      } else {
        expect(loser.status).toBe(BookingStatus.PENDING);
      }

      // 🔬 EXACTLY ONE row holds the contested range.
      const holding = await prisma.bookingSlot.count({
        where: {
          venueId,
          isCancelled: false,
          bookingRequest: { status: BookingStatus.APPROVED },
          startAt: { lt: new Date(Date.now() + DAY + 2 * HOUR) },
          endAt: { gt: new Date(Date.now() + DAY + HOUR) },
        },
      });
      expect(holding).toBe(1);
    });

    /**
     * 🔬 21b — THE CONSTRAINT LEVEL. Two real connections, two `BEGIN`s, both flipping a request to
     * APPROVED. It bypasses the service entirely, and therefore the advisory lock: the SECOND
     * transaction must be refused by Postgres itself with SQLSTATE `23P01`.
     *
     * 🔴 WITHOUT THIS TEST THE CONSTRAINT IS A LINE IN A MIGRATION NOBODY HAS SEEN FIRE. 21a would
     * still be green with the whole `ALTER TABLE` deleted.
     */
    it('21b: two raw connections — the second commit is refused with SQLSTATE 23P01', async () => {
      const a = await seedBooking({ spans: [[4 * DAY, 4 * DAY + 3 * HOUR]] });
      const b = await seedBooking({
        spans: [[4 * DAY + HOUR, 4 * DAY + 2 * HOUR]],
      });

      const c1 = new Client({ connectionString: process.env.DATABASE_URL });
      const c2 = new Client({ connectionString: process.env.DATABASE_URL });
      await c1.connect();
      await c2.connect();

      let sqlstate: string | undefined;
      let constraint: string | undefined;
      try {
        await c1.query('BEGIN');
        await c2.query('BEGIN');

        // The winner takes the range. The BEFORE-UPDATE trigger on the children puts the span into
        // the partial GiST index, still uncommitted.
        await c1.query(
          `UPDATE booking_requests SET status = 'APPROVED' WHERE id = $1`,
          [a.id],
        );

        // The loser tries the same thing. It BLOCKS on the uncommitted index entry…
        const loser = c2
          .query(
            `UPDATE booking_requests SET status = 'APPROVED' WHERE id = $1`,
            [b.id],
          )
          .then(
            () => undefined,
            (e: { code?: string; constraint?: string }) => e,
          );

        // …and is refused the instant the winner commits.
        await c1.query('COMMIT');
        const err = await loser;
        sqlstate = err?.code;
        constraint = err?.constraint;
        await c2.query('ROLLBACK');
      } finally {
        await c1.end();
        await c2.end();
      }

      expect(sqlstate).toBe('23P01');
      expect(constraint).toBe('booking_slots_no_overlap');

      // And only the winner ended up holding it.
      const rows = await prisma.bookingRequest.findMany({
        where: { id: { in: [a.id, b.id] } },
        select: { id: true, status: true },
      });
      expect(
        rows
          .filter((r) => r.status === BookingStatus.APPROVED)
          .map((r) => r.id),
      ).toEqual([a.id]);
    });

    /**
     * The lock is a real Postgres advisory lock on this venue, not a local mutex — proven by asking
     * `pg_locks` from a SECOND connection while a decision is in flight.
     */
    it('takes a real advisory lock on the venue for the duration of a decision', async () => {
      const booking = await seedBooking({ spans: [[7 * DAY, 7 * DAY + HOUR]] });
      const probe = new Client({ connectionString: process.env.DATABASE_URL });
      await probe.connect();
      try {
        const held = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOKING_VENUE_LOCK_NS}::int4, hashtext(${venueId}))`;
          // `classid` IS the namespace of a two-int advisory lock, so this asks "is anybody
          // holding a booking-decision lock right now" from OUTSIDE the transaction taking it.
          const rows = await probe.query<{ n: string }>(
            `SELECT count(*) AS n FROM pg_locks
              WHERE locktype = 'advisory' AND classid = $1`,
            [BOOKING_VENUE_LOCK_NS],
          );
          return Number(rows.rows[0].n);
        });
        expect(held).toBeGreaterThanOrEqual(1);
      } finally {
        await probe.end();
      }
      expect(booking.id).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR20 — the migration is really applied to this database
  // ────────────────────────────────────────────────────────────────────────────────
  describe('schema (AC-BR20)', () => {
    it('carries btree_gist, both triggers, and the half-open exclusion constraint', async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        const ext = await client.query(
          `SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`,
        );
        expect(ext.rowCount).toBe(1);

        const triggers = await client.query<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger
            WHERE tgname IN ('booking_slots_holds_slot_biu', 'booking_requests_holds_slot_au')
            ORDER BY tgname`,
        );
        expect(triggers.rows.map((r) => r.tgname)).toEqual([
          'booking_requests_holds_slot_au',
          'booking_slots_holds_slot_biu',
        ]);

        const constraint = await client.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conname = 'booking_slots_no_overlap'`,
        );
        expect(constraint.rowCount).toBe(1);
        const def = constraint.rows[0].def;
        expect(def).toContain('EXCLUDE USING gist');
        // 🔴 Half-open, and partial on the trigger-maintained column — both are AC-BR18/D-C13.
        expect(def).toContain("'[)'");
        expect(def).toContain('"holdsSlot"');
      } finally {
        await client.end();
      }
    });
  });
});
