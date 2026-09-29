import type { INestApplication } from '@nestjs/common';
import { BookingStatus, SystemRole, type AppSetting } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { AUTO_REJECTED_REASON } from '../src/bookings/bookings.constants';
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
 * `GET /api/v1/reports/overview` — Reports Phase 1, Hub 1 (design §2.5, §1.3). Runs against the
 * real dev DB, so EVERY numeric assertion below is scoped to our own `venueId` + `departmentId`
 * (both fixtures created here): `effectiveDepartmentWhere` and the venue filter make it impossible
 * for a real dev-DB row to leak into these totals, so exact counts are safe to assert (unlike
 * `booking-requests.e2e-spec.ts`, which cannot filter and is red against global data).
 */

const PREFIX = 'e2e-rpt-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;
const bkk = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - 7 * 3_600_000);

const TEST_START = '2020-01-06'; // Monday
const TEST_END = '2020-01-12'; // Sunday — a plain, non-break, non-future week.
const LEAD_MINUTES_KEY = 'booking.cancel_lead_minutes';
const LEAD_MINUTES_VALUE = '30';

interface Session {
  agent: request.Agent;
  token: string;
}

interface OverviewBody {
  range: {
    startDate: string;
    endDate: string;
    schoolDays: number;
    effectiveEndDate: string | null;
  };
  requests: {
    total: number;
    approved: number;
    approvedPercent: number;
    rejected: number;
    rejectedPercent: number;
    autoRejected: number;
    cancelled: number;
    cancelledPercent: number;
    expired: number;
    expiredPercent: number;
    pending: number;
    pendingPercent: number;
  };
  occupancy: {
    heldHours: number;
    schoolDays: number;
    venueCount: number;
    occupancyPercent: number | null;
  };
  discipline: {
    lateCancellations: number;
    noShows: number | null;
    grantedRequests: number;
    lateCancellationPercent: number;
  };
  pendingBacklog: number;
  trend: {
    defaultGrain: 'MONTH' | 'WEEK';
    month: Array<{ from: string; to: string; total: number }>;
    week: Array<{
      from: string;
      to: string;
      total: number;
      heldHours: number;
      occupancyPercent: number | null;
    }>;
  };
  venues: Array<{ venueId: string; heldHours: number; sharePercent: number }>;
}

describe('Reports overview (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};
  let leadSnapshot: AppSetting | null = null;

  let venueId = '';
  let departmentId = 0;
  let reservedDepartmentId = 0;
  let creatorId = '';
  let codeSeq = 0;

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];
  const overview = (email: string, qs: string) =>
    as(email).agent.get(url(`/reports/overview${qs}`));

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
      `DELETE FROM booking_slots WHERE "bookingRequestId" IN (SELECT id FROM booking_requests WHERE code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM booking_requests WHERE code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE name LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE name LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE name LIKE '${PREFIX}%'`,
    );
  };

  const mkRequest = async (opts: {
    status: BookingStatus;
    firstStartAt: Date;
    lastEndAt?: Date;
    rejectReason?: string | null;
    approvedAt?: Date | null;
    slot?: {
      startAt: Date;
      endAt: Date;
      isCancelled?: boolean;
      cancelledAt?: Date | null;
    };
  }) => {
    return prisma.bookingRequest.create({
      data: {
        code: `${PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        venueId,
        departmentId,
        createdById: creatorId,
        purpose: 'ทดสอบ Reports e2e',
        attendees: 5,
        status: opts.status,
        rejectReason: opts.rejectReason ?? null,
        approvedAt: opts.approvedAt ?? null,
        firstStartAt: opts.firstStartAt,
        lastEndAt: opts.lastEndAt ?? opts.slot?.endAt ?? opts.firstStartAt,
        ...(opts.slot
          ? {
              slots: {
                create: {
                  venueId,
                  startAt: opts.slot.startAt,
                  endAt: opts.slot.endAt,
                  isCancelled: opts.slot.isCancelled ?? false,
                  cancelledAt: opts.slot.cancelledAt ?? null,
                },
              },
            }
          : {}),
      },
      select: { id: true, code: true },
    });
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
    await purgeE2eUsers(prisma, PREFIX);
    await purgeRows();

    leadSnapshot = await prisma.appSetting.findUnique({
      where: { key: LEAD_MINUTES_KEY },
    });
    await prisma.appSetting.upsert({
      where: { key: LEAD_MINUTES_KEY },
      create: { key: LEAD_MINUTES_KEY, value: LEAD_MINUTES_VALUE },
      update: { value: LEAD_MINUTES_VALUE },
    });

    const typeId = (
      await prisma.venueType.create({
        data: { name: `${PREFIX}hall` },
        select: { id: true },
      })
    ).id;
    venueId = (
      await prisma.venue.create({
        data: { name: `${PREFIX}main`, venueTypeId: typeId, capacity: 50 },
        select: { id: true },
      })
    ).id;
    departmentId = (
      await prisma.department.create({
        data: { name: `${PREFIX}dept` },
        select: { id: true },
      })
    ).id;
    reservedDepartmentId = (
      await prisma.department.create({
        data: { name: `${PREFIX}reserved`, isSystemReserved: true },
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

    // ── The fixture (design §1.3, AC-R5/R6/R7/R11/R12) ──
    // A: APPROVED, Mon 07:00-09:30 -> clipped to 08:30-09:30 = 1.0h held.
    await mkRequest({
      status: BookingStatus.APPROVED,
      firstStartAt: bkk(2020, 1, 6, 7, 0),
      approvedAt: bkk(2020, 1, 6, 6, 0),
      slot: { startAt: bkk(2020, 1, 6, 7, 0), endAt: bkk(2020, 1, 6, 9, 30) },
    });
    // B: APPROVED, Saturday 10:00-12:00 -> 0h held (weekend).
    await mkRequest({
      status: BookingStatus.APPROVED,
      firstStartAt: bkk(2020, 1, 11, 10, 0),
      approvedAt: bkk(2020, 1, 11, 9, 0),
      slot: {
        startAt: bkk(2020, 1, 11, 10, 0),
        endAt: bkk(2020, 1, 11, 12, 0),
      },
    });
    // C: APPROVED then LATE-cancelled (5 min before start, lead = 30 min) -> 0h held, +1 late cancel.
    await mkRequest({
      status: BookingStatus.APPROVED,
      firstStartAt: bkk(2020, 1, 7, 10, 0),
      approvedAt: bkk(2020, 1, 7, 8, 0),
      slot: {
        startAt: bkk(2020, 1, 7, 10, 0),
        endAt: bkk(2020, 1, 7, 11, 0),
        isCancelled: true,
        cancelledAt: bkk(2020, 1, 7, 9, 55),
      },
    });
    // D: REJECTED, auto (ADR-001 marker).
    await mkRequest({
      status: BookingStatus.REJECTED,
      firstStartAt: bkk(2020, 1, 8, 10, 0),
      rejectReason: AUTO_REJECTED_REASON,
    });
    // E: REJECTED, manual.
    await mkRequest({
      status: BookingStatus.REJECTED,
      firstStartAt: bkk(2020, 1, 8, 13, 0),
      rejectReason: 'ไม่เหมาะสมกับสถานที่',
    });
    // F: CANCELLED (whole request).
    await mkRequest({
      status: BookingStatus.CANCELLED,
      firstStartAt: bkk(2020, 1, 9, 10, 0),
    });
    // G: EXPIRED.
    await mkRequest({
      status: BookingStatus.EXPIRED,
      firstStartAt: bkk(2020, 1, 10, 10, 0),
    });
    // H: PENDING.
    await mkRequest({
      status: BookingStatus.PENDING,
      firstStartAt: bkk(2020, 1, 12, 10, 0),
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await purgeRows();
      await purgeE2eUsers(prisma, PREFIX);
      if (leadSnapshot) {
        await prisma.appSetting.update({
          where: { key: LEAD_MINUTES_KEY },
          data: { value: leadSnapshot.value },
        });
      } else {
        await prisma.appSetting.deleteMany({
          where: { key: LEAD_MINUTES_KEY },
        });
      }
    }
    if (app) await app.close();
  });

  const fixtureQs = () =>
    `?startDate=${TEST_START}&endDate=${TEST_END}&venueId=${venueId}&departmentId=${departmentId}`;

  describe('auth / roles', () => {
    it('no session -> 401', async () => {
      await request(server())
        .get(url(`/reports/overview${fixtureQs()}`))
        .expect(401);
    });

    it('SUPER_ADMIN, ADMIN, VIEWER all get 200 (D-15/AC-R14)', async () => {
      for (const who of [SUPER, ADMIN, VIEWER]) {
        await overview(who, fixtureQs()).expect(200);
      }
    });
  });

  describe('happy path — the seeded fixture (AC-R5, AC-R6, AC-R7, AC-R11, AC-R12)', () => {
    it('requests breakdown is exact, and OQ-2 percentages sum to 100', async () => {
      const body = (await overview(SUPER, fixtureQs()).expect(200))
        .body as OverviewBody;
      expect(body.requests).toMatchObject({
        total: 8,
        approved: 3,
        rejected: 2,
        autoRejected: 1,
        cancelled: 1,
        expired: 1,
        pending: 1,
      });
      const sum =
        body.requests.approvedPercent +
        body.requests.rejectedPercent +
        body.requests.cancelledPercent +
        body.requests.expiredPercent +
        body.requests.pendingPercent;
      expect(sum).toBeCloseTo(100, 8);
      expect(body.requests.expiredPercent).toBeCloseTo(12.5, 8);
    });

    it('AC-R6: occupancy — 1.0h held out of 5 school days x 8h x 1 venue = 2.5%', async () => {
      const body = (await overview(SUPER, fixtureQs()).expect(200))
        .body as OverviewBody;
      expect(body.range.schoolDays).toBe(5);
      expect(body.occupancy.schoolDays).toBe(5);
      expect(body.occupancy.venueCount).toBe(1);
      expect(body.occupancy.heldHours).toBeCloseTo(1.0, 8);
      expect(body.occupancy.occupancyPercent).toBeCloseTo(2.5, 8);
    });

    it('AC-R7: one late cancellation out of 3 granted requests', async () => {
      const body = (await overview(SUPER, fixtureQs()).expect(200))
        .body as OverviewBody;
      expect(body.discipline.lateCancellations).toBe(1);
      expect(body.discipline.grantedRequests).toBe(3);
      expect(body.discipline.lateCancellationPercent).toBeCloseTo(100 / 3, 6);
      expect(body.discipline.noShows).toBeNull();
    });

    it('AC-R11: the single filtered venue carries all the held hours (Σ = occupancy.heldHours)', async () => {
      const body = (await overview(SUPER, fixtureQs()).expect(200))
        .body as OverviewBody;
      expect(body.venues).toHaveLength(1);
      expect(body.venues[0].venueId).toBe(venueId);
      expect(body.venues[0].heldHours).toBeCloseTo(body.occupancy.heldHours, 8);
      expect(body.venues[0].sharePercent).toBeCloseTo(2.5, 8);
    });

    it('AC-R12: the single week bucket (default grain) carries the same totals as the KPIs', async () => {
      const body = (await overview(SUPER, fixtureQs()).expect(200))
        .body as OverviewBody;
      expect(body.trend.defaultGrain).toBe('WEEK');
      expect(body.trend.week).toHaveLength(1);
      expect(body.trend.week[0]).toMatchObject({
        from: TEST_START,
        to: TEST_END,
      });
      const weekTotal = body.trend.week.reduce((s, b) => s + b.total, 0);
      expect(weekTotal).toBe(body.requests.total);
      const weekHeld = body.trend.week.reduce((s, b) => s + b.heldHours, 0);
      expect(weekHeld).toBeCloseTo(body.occupancy.heldHours, 8);

      const monthTotal = body.trend.month.reduce((s, b) => s + b.total, 0);
      expect(monthTotal).toBe(body.requests.total);
    });

    it('AC-R8: pendingBacklog ignores every filter and reflects at least our PENDING fixture', async () => {
      const filtered = (await overview(SUPER, fixtureQs()).expect(200))
        .body as OverviewBody;
      const unfiltered = (
        await overview(
          SUPER,
          `?startDate=${TEST_START}&endDate=${TEST_END}`,
        ).expect(200)
      ).body as OverviewBody;
      // Same global count regardless of venue/department filters (AC-R8).
      expect(filtered.pendingBacklog).toBe(unfiltered.pendingBacklog);
      expect(filtered.pendingBacklog).toBeGreaterThanOrEqual(1);
    });
  });

  describe('AC-R15 — coded validation errors', () => {
    const codeOf = (res: request.Response) =>
      (res.body as { code?: string }).code;

    it('a malformed date -> 400 REPORT_DATE_INVALID', async () => {
      const res = await overview(
        SUPER,
        '?startDate=2020-02-30&endDate=2020-03-01',
      ).expect(400);
      expect(codeOf(res)).toBe('REPORT_DATE_INVALID');
    });

    it('startDate > endDate -> 400 REPORT_RANGE_INVERTED', async () => {
      const res = await overview(
        SUPER,
        `?startDate=${TEST_END}&endDate=${TEST_START}`,
      ).expect(400);
      expect(codeOf(res)).toBe('REPORT_RANGE_INVERTED');
    });

    it('a range over 366 days -> 400 REPORT_RANGE_TOO_WIDE', async () => {
      const res = await overview(
        SUPER,
        '?startDate=2019-01-01&endDate=2020-01-02',
      ).expect(400);
      expect(codeOf(res)).toBe('REPORT_RANGE_TOO_WIDE');
    });

    it('an unknown venueId -> 400 REPORT_VENUE_INVALID', async () => {
      const res = await overview(
        SUPER,
        `?startDate=${TEST_START}&endDate=${TEST_END}&venueId=e2e-rpt-does-not-exist`,
      ).expect(400);
      expect(codeOf(res)).toBe('REPORT_VENUE_INVALID');
    });

    it('an unknown departmentId -> 400 REPORT_DEPARTMENT_INVALID', async () => {
      const res = await overview(
        SUPER,
        `?startDate=${TEST_START}&endDate=${TEST_END}&departmentId=999999999`,
      ).expect(400);
      expect(codeOf(res)).toBe('REPORT_DEPARTMENT_INVALID');
    });

    it('a reserved department as ADMIN -> the SAME 400 as unknown; as SUPER_ADMIN -> 200 (no existence oracle)', async () => {
      const asAdmin = await overview(
        ADMIN,
        `?startDate=${TEST_START}&endDate=${TEST_END}&departmentId=${reservedDepartmentId}`,
      ).expect(400);
      expect(codeOf(asAdmin)).toBe('REPORT_DEPARTMENT_INVALID');

      await overview(
        SUPER,
        `?startDate=${TEST_START}&endDate=${TEST_END}&departmentId=${reservedDepartmentId}`,
      ).expect(200);
    });

    it('an unknown query key -> 400, uncoded pipe body (forbidNonWhitelisted)', async () => {
      const res = await overview(
        SUPER,
        `?startDate=${TEST_START}&endDate=${TEST_END}&bogus=1`,
      ).expect(400);
      expect(codeOf(res)).toBeUndefined();
    });
  });

  describe('empty result (AC-R13 shape)', () => {
    it('a range entirely in the future is empty: zero counts, null effectiveEndDate/occupancy', async () => {
      const future = new Date(Date.now() + 400 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const res = await overview(
        SUPER,
        `?startDate=${future}&endDate=${future}`,
      ).expect(200);
      const body = res.body as OverviewBody;
      expect(body.requests.total).toBe(0);
      expect(body.range.effectiveEndDate).toBeNull();
      expect(body.occupancy.occupancyPercent).toBeNull();
    });
  });
});
