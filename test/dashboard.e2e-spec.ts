import type { INestApplication } from '@nestjs/common';
import { BookingStatus, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
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

jest.setTimeout(120_000);

/**
 * `GET /api/v1/dashboard/vitals` and `/dashboard/venues-live` — Reports Phase 1, Hub 7 (design
 * §2.2, §2.3). Runs against the real dev DB (memory note): every assertion is either a SHAPE
 * invariant or a DELTA against a snapshot this suite itself creates, never a global count. Fixture
 * rows carry a unique prefix and are purged by id in `afterAll`.
 */

const SU_PREFIX = 'e2e-dashsu-';
const ROW_PREFIX = 'e2e-dash-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface VenueDto {
  id: string;
  name: string;
  state: 'BUSY' | 'FREE' | 'OFF';
  closedReason: string | null;
  current: {
    code: string;
    elapsedPercent: number;
    remainingMinutes: number;
  } | null;
  next: { startAt: string } | null;
  freeWindow: string | null;
}

interface VenuesLiveBody {
  counts: { all: number; busy: number; free: number; off: number };
  venues: VenueDto[];
}

interface QueueItem {
  id: string;
  code: string;
  requesterName: string | null;
  departmentName: string | null;
  dayOffset: number;
  firstSlot: { startAt: string; endAt: string };
}

interface VitalsBody {
  pendingRequests: number;
  pendingLineUsers: number;
  pendingQueue: QueueItem[];
}

describe('Dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};

  let venueId = '';
  let closedVenueId = '';
  let creatorId = '';
  let codeSeq = 0;

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];
  const get = (email: string, path: string) => as(email).agent.get(url(path));

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

  const seedBooking = async (opts: {
    status: BookingStatus;
    venue?: string;
    spans: [number, number][];
    requesterName?: string;
    createdAt?: Date;
    firstStartAtOverride?: Date;
  }): Promise<{ id: string; code: string }> => {
    // Spans are relative to `firstStartAtOverride` when given (so the slot dates stay consistent
    // with the overridden `firstStartAt` column — e.g. an epoch-anchored D-6 ordering fixture),
    // otherwise relative to "now".
    const anchor = opts.firstStartAtOverride?.getTime() ?? Date.now();
    const spans = opts.spans.map(([s, e]) => ({
      start: new Date(anchor + s),
      end: new Date(anchor + e),
    }));
    const firstStartAt =
      opts.firstStartAtOverride ??
      new Date(Math.min(...spans.map((s) => s.start.getTime())));
    const created = await prisma.bookingRequest.create({
      data: {
        code: `${ROW_PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        venueId: opts.venue ?? venueId,
        // `booking_requests_owner_check` requires lineUserId OR createdById — an ADMIN-origin
        // fixture is the simplest fixture shape here (no LineUser row needed).
        createdById: creatorId,
        requesterName: opts.requesterName ?? 'ผู้ทดสอบ อีทูอี',
        contactPhone: '080-000-0000',
        purpose: 'ทดสอบ Dashboard e2e',
        attendees: 5,
        status: opts.status,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        firstStartAt,
        lastEndAt: new Date(Math.max(...spans.map((s) => s.end.getTime()))),
        ...(opts.status === BookingStatus.APPROVED
          ? { approvedAt: new Date() }
          : {}),
        slots: {
          create: spans.map((s) => ({
            venueId: opts.venue ?? venueId,
            startAt: s.start,
            endAt: s.end,
          })),
        },
      },
      select: { id: true, code: true },
    });
    return created;
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
    await purgeE2eUsers(prisma, SU_PREFIX);
    await purgeRows();

    const typeId = (
      await prisma.venueType.create({
        data: { name: `${ROW_PREFIX}hall` },
        select: { id: true },
      })
    ).id;
    venueId = (
      await prisma.venue.create({
        data: { name: `${ROW_PREFIX}main`, venueTypeId: typeId, capacity: 50 },
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
          closedReason: `${ROW_PREFIX}closed reason`,
        },
        select: { id: true },
      })
    ).id;

    const options = await ensureE2eOptions(prisma);
    const passwordHash = await new PasswordService().hash(PASSWORD);
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
    ] as Array<[string, SystemRole]>) {
      const created = await prisma.systemUser.create({
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
      if (email === SUPER) creatorId = created.id;
    }
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER])
      sessions[email] = await login(email);
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await purgeRows();
      await purgeE2eUsers(prisma, SU_PREFIX);
    }
    if (app) await app.close();
  });

  describe('auth / roles', () => {
    it('no session -> 401 on both routes', async () => {
      await request(server()).get(url('/dashboard/vitals')).expect(401);
      await request(server()).get(url('/dashboard/venues-live')).expect(401);
    });

    it('SUPER_ADMIN, ADMIN, VIEWER all get 200 on both routes (D-15)', async () => {
      for (const who of [SUPER, ADMIN, VIEWER]) {
        await get(who, '/dashboard/vitals').expect(200);
        await get(who, '/dashboard/venues-live').expect(200);
      }
    });
  });

  describe('GET /dashboard/venues-live — shape (AC-D6..D11)', () => {
    it('counts.all = busy + free + off = venues.length, and our fixture venues appear exactly once', async () => {
      const body = (await get(ADMIN, '/dashboard/venues-live').expect(200))
        .body as VenuesLiveBody;
      expect(body.counts.all).toBe(
        body.counts.busy + body.counts.free + body.counts.off,
      );
      expect(body.counts.all).toBe(body.venues.length);

      const ours = body.venues.filter(
        (v) => v.id === venueId || v.id === closedVenueId,
      );
      expect(ours).toHaveLength(2);
    });

    it('OQ-3: our closed venue is OFF with its closedReason, even with no bookings', async () => {
      const body = (await get(ADMIN, '/dashboard/venues-live').expect(200))
        .body as VenuesLiveBody;
      const closed = body.venues.find((v) => v.id === closedVenueId);
      expect(closed?.state).toBe('OFF');
      expect(closed?.closedReason).toBe(`${ROW_PREFIX}closed reason`);
      expect(closed?.current).toBeNull();
    });

    it('AC-D7: an APPROVED slot covering now makes the venue BUSY, with elapsed/remaining computed', async () => {
      const { code } = await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[-30 * MINUTE, 30 * MINUTE]],
      });
      const body = (await get(ADMIN, '/dashboard/venues-live').expect(200))
        .body as VenuesLiveBody;
      const ours = body.venues.find((v) => v.id === venueId);
      expect(ours?.state).toBe('BUSY');
      expect(ours?.current?.code).toBe(code);
      expect(ours?.current?.elapsedPercent).toBeGreaterThanOrEqual(0);
      expect(ours?.current?.elapsedPercent).toBeLessThanOrEqual(100);
      expect(ours?.current?.remainingMinutes).toBeGreaterThanOrEqual(1);
    });

    it('AC-D8: a FREE venue with a later slot today reports UNTIL_NEXT', async () => {
      await purgeRows();
      // re-create the two venues purged along with the booking rows above.
      const typeId = (
        await prisma.venueType.create({
          data: { name: `${ROW_PREFIX}hall` },
          select: { id: true },
        })
      ).id;
      venueId = (
        await prisma.venue.create({
          data: {
            name: `${ROW_PREFIX}main`,
            venueTypeId: typeId,
            capacity: 50,
          },
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
            closedReason: `${ROW_PREFIX}closed reason`,
          },
          select: { id: true },
        })
      ).id;

      await seedBooking({
        status: BookingStatus.APPROVED,
        spans: [[2 * HOUR, 3 * HOUR]],
      });
      const body = (await get(ADMIN, '/dashboard/venues-live').expect(200))
        .body as VenuesLiveBody;
      const ours = body.venues.find((v) => v.id === venueId);
      expect(ours?.state).toBe('FREE');
      expect(ours?.freeWindow).toBe('UNTIL_NEXT');
      expect(ours?.next?.startAt).toBeTruthy();
    });
  });

  describe('GET /dashboard/vitals — queue ordering (D-6, AC-D12)', () => {
    it('the top 4 are our earliest-firstStartAt fixtures, in D-6 order, with a negative dayOffset', async () => {
      await purgeRows();
      const typeId = (
        await prisma.venueType.create({
          data: { name: `${ROW_PREFIX}hall` },
          select: { id: true },
        })
      ).id;
      venueId = (
        await prisma.venue.create({
          data: {
            name: `${ROW_PREFIX}main`,
            venueTypeId: typeId,
            capacity: 50,
          },
          select: { id: true },
        })
      ).id;

      // Five PENDING requests with firstStartAt at the epoch + i days — guaranteed to sort before
      // any real, present-day fixture in the dev DB.
      const codes: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const created = await seedBooking({
          status: BookingStatus.PENDING,
          spans: [[10 * DAY, 11 * DAY]], // irrelevant to ordering; firstStartAtOverride wins below
          firstStartAtOverride: new Date(i * DAY),
          requesterName: `${ROW_PREFIX}requester-${i}`,
        });
        codes.push(created.code);
      }

      const body = (await get(ADMIN, '/dashboard/vitals').expect(200))
        .body as VitalsBody;
      expect(body.pendingQueue).toHaveLength(4);
      expect(body.pendingQueue.map((q) => q.code)).toEqual(codes.slice(0, 4));
      for (const item of body.pendingQueue) {
        expect(item.dayOffset).toBeLessThan(0);
        expect(item.requesterName).toMatch(
          new RegExp(`^${ROW_PREFIX}requester-`),
        );
      }
    });
  });

  describe('ADR-001 regression (AC-D14)', () => {
    it('approving a queued request drops it and its auto-rejected losers from pendingRequests', async () => {
      await purgeRows();
      const typeId = (
        await prisma.venueType.create({
          data: { name: `${ROW_PREFIX}hall` },
          select: { id: true },
        })
      ).id;
      venueId = (
        await prisma.venue.create({
          data: {
            name: `${ROW_PREFIX}main`,
            venueTypeId: typeId,
            capacity: 50,
          },
          select: { id: true },
        })
      ).id;

      const winner = await seedBooking({
        status: BookingStatus.PENDING,
        spans: [[DAY, DAY + HOUR]],
      });
      await seedBooking({
        status: BookingStatus.PENDING,
        spans: [[DAY + 15 * MINUTE, DAY + 45 * MINUTE]], // overlaps the winner
      });

      const before = (await get(SUPER, '/dashboard/vitals').expect(200))
        .body as VitalsBody;

      const approveRes = await as(SUPER)
        .agent.post(url(`/booking-requests/${winner.id}/approve`))
        .set('x-csrf-token', as(SUPER).token)
        .send({})
        .expect(200);
      const autoRejectedCount = (approveRes.body as { autoRejected: unknown[] })
        .autoRejected.length;
      expect(autoRejectedCount).toBe(1);

      const after = (await get(SUPER, '/dashboard/vitals').expect(200))
        .body as VitalsBody;
      expect(before.pendingRequests - after.pendingRequests).toBe(
        1 + autoRejectedCount,
      );
    });
  });
});
