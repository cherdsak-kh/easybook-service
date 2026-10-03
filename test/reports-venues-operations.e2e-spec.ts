import type { INestApplication } from '@nestjs/common';
import { BookingStatus, SystemRole, type AppSetting } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { AUTO_REJECTED_REASON } from '../src/bookings/bookings.constants';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, dayStart } from '../src/reports/report-calendar';
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
 * Reports Phase 2 — Hub 2 `GET /reports/venues` and Hub 3 `GET /reports/operations` (design §2.5,
 * §2.6, checklist item 8). Runs against the real dev DB.
 *
 * Neither endpoint takes a venue/department filter (D-10), so EVERY numeric assertion is scoped by
 * choosing a WINDOW verified empty of real data before seeding (`beforeAll` throws otherwise), and
 * cleaning up strictly by id in `afterAll`. This is what makes exact (not merely delta) unfiltered
 * assertions safe here, unlike `test/booking-requests.e2e-spec.ts`.
 */

const PREFIX = 'e2e-rpt2-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;
const bkk = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - 7 * 3_600_000);

// A window verified empty before seeding: Mon-Fri weeks, a Saturday, and part of the 1 Apr-15 May
// summer break — well inside the 366-day cap and comfortably in the past.
const WINDOW_START = '2020-01-06';
const WINDOW_END = '2020-04-30';
const LEAD_MINUTES_KEY = 'booking.cancel_lead_minutes';
const LEAD_MINUTES_VALUE = '30';
const HOUR_MS = 3_600_000;

interface Session {
  agent: request.Agent;
  token: string;
}

describe('Reports venues / operations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};
  let leadSnapshot: AppSetting | null = null;

  let venueOpenId = '';
  let venueClosedId = '';
  let venueDeletedId = '';
  let deptOrdinaryId = 0;
  let deptDeletedId = 0;
  let deptReservedId = 0;
  let liffLineUserId = '';
  let creatorId = '';
  let codeSeq = 0;

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];
  const venues = (email: string, qs = '') =>
    as(email).agent.get(url(`/reports/venues${qs}`));
  const operations = (email: string, qs = '') =>
    as(email).agent.get(url(`/reports/operations${qs}`));
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
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${PREFIX}%'`,
    );
  };

  interface RequestSpec {
    key: string;
    venueId?: string;
    departmentId?: number | null;
    liff?: boolean; // true -> lineUserId set, createdById null. false (default) -> staff-created.
    status: BookingStatus;
    rejectReason?: string | null;
    createdAt: Date;
    approvedAt?: Date | null;
    updatedAt?: Date; // forced via raw SQL after create (Prisma @updatedAt would otherwise overwrite it)
    slots?: {
      startAt: Date;
      endAt: Date;
      isCancelled?: boolean;
      cancelledAt?: Date | null;
      cancelledByRole?: string | null;
      cancelReason?: string | null;
    }[];
  }

  const mkRequest = async (spec: RequestSpec) => {
    const slots = spec.slots ?? [];
    const firstStartAt = slots[0]?.startAt ?? spec.createdAt;
    const lastEndAt = slots[slots.length - 1]?.endAt ?? firstStartAt;
    const created = await prisma.bookingRequest.create({
      data: {
        code: `${PREFIX}${spec.key}-${String(++codeSeq).padStart(4, '0')}`,
        venueId: spec.venueId ?? venueOpenId,
        departmentId:
          spec.departmentId === undefined ? null : spec.departmentId,
        lineUserId: spec.liff ? liffLineUserId : null,
        createdById: spec.liff ? null : creatorId,
        approvedById: !spec.liff && spec.approvedAt ? creatorId : null,
        purpose: 'ทดสอบ Reports Phase 2 e2e',
        attendees: 5,
        status: spec.status,
        rejectReason: spec.rejectReason ?? null,
        approvedAt: spec.approvedAt ?? null,
        firstStartAt,
        lastEndAt,
        createdAt: spec.createdAt,
        slots:
          slots.length > 0
            ? {
                create: slots.map((s) => ({
                  venueId: spec.venueId ?? venueOpenId,
                  startAt: s.startAt,
                  endAt: s.endAt,
                  isCancelled: s.isCancelled ?? false,
                  cancelledAt: s.cancelledAt ?? null,
                  cancelledByRole: s.cancelledByRole ?? null,
                  cancelReason: s.cancelReason ?? null,
                })),
              }
            : undefined,
      },
      select: { id: true, code: true },
    });
    if (spec.updatedAt) {
      await prisma.$executeRaw`UPDATE booking_requests SET "updatedAt" = ${spec.updatedAt} WHERE id = ${created.id}`;
    }
    return created;
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
    await purgeE2eUsers(prisma, PREFIX);
    await purgeRows();

    // ── Empty-window guard: never seed on top of real data (memory: e2e runs against the dev DB) ──
    const S = dayStart(WINDOW_START);
    const E = dayStart(addDays(WINDOW_END, 1));
    const existingRequests = await prisma.bookingRequest.count({
      where: { firstStartAt: { gte: S, lt: E } },
    });
    const existingSlots = await prisma.bookingSlot.count({
      where: { startAt: { lt: E }, endAt: { gt: S } },
    });
    if (existingRequests > 0 || existingSlots > 0) {
      throw new Error(
        `reports-venues-operations.e2e-spec: window ${WINDOW_START}..${WINDOW_END} is NOT empty ` +
          `(requests=${existingRequests}, slots=${existingSlots}) — refusing to seed on top of real data.`,
      );
    }

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
    venueOpenId = (
      await prisma.venue.create({
        data: { name: `${PREFIX}open`, venueTypeId: typeId, capacity: 50 },
        select: { id: true },
      })
    ).id;
    venueClosedId = (
      await prisma.venue.create({
        data: {
          name: `${PREFIX}closed`,
          venueTypeId: typeId,
          capacity: 20,
          isOpen: false,
          closedReason: 'ปิดปรับปรุง',
        },
        select: { id: true },
      })
    ).id;
    venueDeletedId = (
      await prisma.venue.create({
        data: { name: `${PREFIX}deleted`, venueTypeId: typeId, capacity: 30 },
        select: { id: true },
      })
    ).id;

    deptOrdinaryId = (
      await prisma.department.create({
        data: { name: `${PREFIX}dept` },
        select: { id: true },
      })
    ).id;
    deptDeletedId = (
      await prisma.department.create({
        data: { name: `${PREFIX}dept-deleted` },
        select: { id: true },
      })
    ).id;
    deptReservedId = (
      await prisma.department.create({
        data: { name: `${PREFIX}dept-reserved`, isSystemReserved: true },
        select: { id: true },
      })
    ).id;

    liffLineUserId = (
      await prisma.lineUser.create({
        data: { lineUserId: `${PREFIX}Uliff0000000000000000000000000` },
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
      const createdUser = await prisma.systemUser.create({
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
      if (email === SUPER) creatorId = createdUser.id;
    }
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER])
      sessions[email] = await login(email);

    // ── The fixture (design §2.1-§2.3, checklist item 8) ──────────────────────────────────────
    // A: LIFF APPROVED, Mon 09:00-10:00 -> 1h held. Decided in 3h (SLA).
    await mkRequest({
      key: 'a',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 6, 6, 0),
      approvedAt: bkk(2020, 1, 6, 9, 0),
      slots: [
        { startAt: bkk(2020, 1, 6, 9, 0), endAt: bkk(2020, 1, 6, 10, 0) },
      ],
    });
    // B: LIFF REJECTED (manual), turnaround forced to 30h (breach).
    await mkRequest({
      key: 'b',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.REJECTED,
      rejectReason: 'ไม่เหมาะสมกับสถานที่',
      createdAt: bkk(2020, 1, 7, 6, 0),
      updatedAt: new Date(bkk(2020, 1, 7, 6, 0).getTime() + 30 * HOUR_MS),
    });
    // C: LIFF auto-rejected (ADR-001 marker).
    await mkRequest({
      key: 'c',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.REJECTED,
      rejectReason: AUTO_REJECTED_REASON,
      createdAt: bkk(2020, 1, 8, 6, 0),
    });
    // D: staff direct booking, Thu 10:00-11:00 -> 1h held. Excluded from SLA (staffCreated).
    await mkRequest({
      key: 'd',
      departmentId: deptOrdinaryId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 9, 9, 0),
      approvedAt: bkk(2020, 1, 9, 9, 0),
      slots: [
        { startAt: bkk(2020, 1, 9, 10, 0), endAt: bkk(2020, 1, 9, 11, 0) },
      ],
    });
    // E: LIFF approved then LATE-cancelled 10 min before start -> registry row "ก่อนเริ่ม 10 นาที".
    await mkRequest({
      key: 'e',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.CANCELLED,
      createdAt: bkk(2020, 1, 10, 9, 0),
      approvedAt: bkk(2020, 1, 10, 10, 0),
      slots: [
        {
          startAt: bkk(2020, 1, 10, 10, 0),
          endAt: bkk(2020, 1, 10, 11, 0),
          isCancelled: true,
          cancelledAt: bkk(2020, 1, 10, 9, 50),
          cancelledByRole: 'ADMIN',
          cancelReason: 'ทดสอบยกเลิกกระชั้นชิด',
        },
      ],
    });
    // F: LIFF cancelled before any decision (withdrawn).
    await mkRequest({
      key: 'f',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.CANCELLED,
      createdAt: bkk(2020, 1, 13, 9, 0),
    });
    // G: EXPIRED.
    await mkRequest({
      key: 'g',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.EXPIRED,
      createdAt: bkk(2020, 1, 14, 9, 0),
    });
    // H: still PENDING.
    await mkRequest({
      key: 'h',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.PENDING,
      createdAt: bkk(2020, 1, 15, 9, 0),
    });
    // I: LIFF approved then LATE-cancelled 15 min AFTER start -> registry "หลังเริ่ม 15 นาที".
    await mkRequest({
      key: 'i',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.CANCELLED,
      createdAt: bkk(2020, 1, 16, 8, 0),
      approvedAt: bkk(2020, 1, 16, 10, 0),
      slots: [
        {
          startAt: bkk(2020, 1, 16, 10, 0),
          endAt: bkk(2020, 1, 16, 11, 0),
          isCancelled: true,
          cancelledAt: bkk(2020, 1, 16, 10, 15),
          cancelledByRole: 'LINE_USER',
          cancelReason: null,
        },
      ],
    });
    // J: LIFF approved then cancelled 31 min before start -> NOT late, no registry row.
    await mkRequest({
      key: 'j',
      departmentId: deptOrdinaryId,
      liff: true,
      status: BookingStatus.CANCELLED,
      createdAt: bkk(2020, 1, 17, 9, 0),
      approvedAt: bkk(2020, 1, 17, 9, 0),
      slots: [
        {
          startAt: bkk(2020, 1, 17, 10, 0),
          endAt: bkk(2020, 1, 17, 11, 0),
          isCancelled: true,
          cancelledAt: bkk(2020, 1, 17, 9, 29),
          cancelledByRole: 'ADMIN',
          cancelReason: null,
        },
      ],
    });
    // K: staff APPROVED, Saturday 10:00-12:00 -> 0h held (weekend).
    await mkRequest({
      key: 'k',
      departmentId: deptOrdinaryId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 18, 9, 0),
      approvedAt: bkk(2020, 1, 18, 9, 0),
      slots: [
        { startAt: bkk(2020, 1, 18, 10, 0), endAt: bkk(2020, 1, 18, 12, 0) },
      ],
    });
    // L: staff APPROVED, Mon 07:00-09:30 -> clipped to 08:30-09:30 = 1h held.
    await mkRequest({
      key: 'l',
      departmentId: deptOrdinaryId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 20, 6, 0),
      approvedAt: bkk(2020, 1, 20, 6, 0),
      slots: [
        { startAt: bkk(2020, 1, 20, 7, 0), endAt: bkk(2020, 1, 20, 9, 30) },
      ],
    });
    // M: staff APPROVED, cross-midnight Tue 23:00 -> Wed 09:00 -> 0.5h held on Wed.
    await mkRequest({
      key: 'm',
      departmentId: deptOrdinaryId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 21, 20, 0),
      approvedAt: bkk(2020, 1, 21, 20, 0),
      slots: [
        { startAt: bkk(2020, 1, 21, 23, 0), endAt: bkk(2020, 1, 22, 9, 0) },
      ],
    });
    // N: staff APPROVED, inside the summer break -> 0h held.
    await mkRequest({
      key: 'n',
      departmentId: deptOrdinaryId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 4, 10, 8, 0),
      approvedAt: bkk(2020, 4, 10, 8, 0),
      slots: [
        { startAt: bkk(2020, 4, 10, 9, 0), endAt: bkk(2020, 4, 10, 10, 0) },
      ],
    });
    // O: staff APPROVED, RESERVED department -> 1h held (AC-O7).
    await mkRequest({
      key: 'o',
      departmentId: deptReservedId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 22, 12, 0),
      approvedAt: bkk(2020, 1, 22, 12, 0),
      slots: [
        { startAt: bkk(2020, 1, 22, 13, 0), endAt: bkk(2020, 1, 22, 14, 0) },
      ],
    });
    // P: staff APPROVED, department to be soft-deleted after seeding -> 1h held.
    await mkRequest({
      key: 'p',
      departmentId: deptDeletedId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 23, 12, 0),
      approvedAt: bkk(2020, 1, 23, 12, 0),
      slots: [
        { startAt: bkk(2020, 1, 23, 13, 0), endAt: bkk(2020, 1, 23, 14, 0) },
      ],
    });
    // Q: staff APPROVED, no department (ไม่ระบุกลุ่ม/ฝ่าย) -> 1h held.
    await mkRequest({
      key: 'q',
      departmentId: null,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 24, 12, 0),
      approvedAt: bkk(2020, 1, 24, 12, 0),
      slots: [
        { startAt: bkk(2020, 1, 24, 13, 0), endAt: bkk(2020, 1, 24, 14, 0) },
      ],
    });
    // R: staff APPROVED at the venue to be soft-deleted after seeding -> 1h held.
    await mkRequest({
      key: 'r',
      venueId: venueDeletedId,
      departmentId: deptOrdinaryId,
      liff: false,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 27, 8, 0),
      approvedAt: bkk(2020, 1, 27, 8, 0),
      slots: [
        { startAt: bkk(2020, 1, 27, 9, 0), endAt: bkk(2020, 1, 27, 10, 0) },
      ],
    });

    // Soft-delete AFTER seeding, so the history rows above are the "activity" that keeps them visible.
    await prisma.department.update({
      where: { id: deptDeletedId },
      data: { deletedAt: new Date() },
    });
    await prisma.venue.update({
      where: { id: venueDeletedId },
      data: { deletedAt: new Date() },
    });
  }, 180_000);

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

  const rangeQs = `?startDate=${WINDOW_START}&endDate=${WINDOW_END}`;

  describe('auth / roles', () => {
    it('no session -> 401 on both routes', async () => {
      await request(server())
        .get(url(`/reports/venues${rangeQs}`))
        .expect(401);
      await request(server())
        .get(url(`/reports/operations${rangeQs}`))
        .expect(401);
    });

    it('SUPER_ADMIN, ADMIN, VIEWER all get 200 on both routes', async () => {
      for (const who of [SUPER, ADMIN, VIEWER]) {
        await venues(who, rangeQs).expect(200);
        await operations(who, rangeQs).expect(200);
      }
    });
  });

  describe('AC-V3 / AC-O2 — coded validation errors, identical to Hub 1', () => {
    const codeOf = (res: request.Response) =>
      (res.body as { code?: string }).code;

    it('a malformed date -> 400 REPORT_DATE_INVALID (both routes)', async () => {
      const v = await venues(
        SUPER,
        '?startDate=2020-02-30&endDate=2020-03-01',
      ).expect(400);
      expect(codeOf(v)).toBe('REPORT_DATE_INVALID');
      const o = await operations(
        SUPER,
        '?startDate=2020-02-30&endDate=2020-03-01',
      ).expect(400);
      expect(codeOf(o)).toBe('REPORT_DATE_INVALID');
    });

    it('startDate > endDate -> 400 REPORT_RANGE_INVERTED', async () => {
      const v = await venues(
        SUPER,
        `?startDate=${WINDOW_END}&endDate=${WINDOW_START}`,
      ).expect(400);
      expect(codeOf(v)).toBe('REPORT_RANGE_INVERTED');
    });

    it('a range over 366 days -> 400 REPORT_RANGE_TOO_WIDE', async () => {
      const o = await operations(
        SUPER,
        '?startDate=2019-01-01&endDate=2020-01-02',
      ).expect(400);
      expect(codeOf(o)).toBe('REPORT_RANGE_TOO_WIDE');
    });

    it('an unknown query key (venueId) -> 400, uncoded pipe body — NOT REPORT_VENUE_INVALID', async () => {
      const v = await venues(SUPER, `${rangeQs}&venueId=${venueOpenId}`).expect(
        400,
      );
      expect(codeOf(v)).toBeUndefined();
      const o = await operations(
        SUPER,
        `${rangeQs}&departmentId=${deptOrdinaryId}`,
      ).expect(400);
      expect(codeOf(o)).toBeUndefined();
    });
  });

  describe('AC-V4 — strict equality with /reports/overview (unfiltered)', () => {
    it('occupancy.occupancyPercent, heldHours, schoolDays, venueCount are all === Hub 1', async () => {
      const hub2 = (await venues(SUPER, rangeQs).expect(200)).body as {
        occupancy: Record<string, unknown>;
      };
      const hub1 = (await overview(SUPER, rangeQs).expect(200)).body as {
        occupancy: Record<string, unknown>;
      };
      expect(hub2.occupancy.occupancyPercent).toBe(
        hub1.occupancy.occupancyPercent,
      );
      expect(hub2.occupancy.heldHours).toBe(hub1.occupancy.heldHours);
      expect(hub2.occupancy.schoolDays).toBe(hub1.occupancy.schoolDays);
      expect(hub2.occupancy.venueCount).toBe(hub1.occupancy.venueCount);
    });
  });

  describe('REPORTS-AC-R11-E2E-1 — Hub 1 unfiltered Σ venues[].heldHours = occupancy.heldHours', () => {
    it('holds on the empty-window fixture, with the exact fixture total (7.5h)', async () => {
      const body = (await overview(SUPER, rangeQs).expect(200)).body as {
        occupancy: { heldHours: number };
        venues: Array<{ heldHours: number }>;
      };
      expect(body.occupancy.heldHours).toBeCloseTo(7.5, 8);
      const sum = body.venues.reduce((s, v) => s + v.heldHours, 0);
      expect(sum).toBeCloseTo(body.occupancy.heldHours, 8);
    });
  });

  describe('AC-V14 — Hub 2 identities', () => {
    it('Σ table heldHours = KPI = Hub 1 occupancy.heldHours; Σ requests/autoRejected match', async () => {
      const body = (await venues(SUPER, rangeQs).expect(200)).body as {
        requests: { total: number; autoRejected: number };
        occupancy: { heldHours: number };
        venues: Array<{
          heldHours: number;
          requests: number;
          autoRejected: number;
        }>;
      };
      expect(body.requests.total).toBe(18);
      expect(body.requests.autoRejected).toBe(1);
      expect(body.occupancy.heldHours).toBeCloseTo(7.5, 8);

      const heldSum = body.venues.reduce((s, v) => s + v.heldHours, 0);
      expect(heldSum).toBeCloseTo(body.occupancy.heldHours, 8);
      const reqSum = body.venues.reduce((s, v) => s + v.requests, 0);
      expect(reqSum).toBe(body.requests.total);
      const autoSum = body.venues.reduce((s, v) => s + v.autoRejected, 0);
      expect(autoSum).toBe(body.requests.autoRejected);

      const deletedVenue = body.venues.find(
        (v) =>
          v.requests === 1 &&
          v.heldHours > 0.9 &&
          v.heldHours < 1.1 &&
          (v as unknown as { isDeleted: boolean }).isDeleted,
      );
      expect(deletedVenue).toBeDefined();
    });

    it('the open venue table row carries the expected figures', async () => {
      const body = (await venues(SUPER, rangeQs).expect(200)).body as {
        venues: Array<{
          venueId: string;
          requests: number;
          heldHours: number;
          approved: number;
          autoRejected: number;
          isOpen: boolean;
          isDeleted: boolean;
        }>;
      };
      // A..N (14) + O, P, Q (which default to venueOpenId — only R uses venueDeletedId) = 17.
      const open = body.venues.find((v) => v.venueId === venueOpenId);
      expect(open).toMatchObject({
        requests: 17,
        approved: 9, // A, D, K, L, M, N, O, P, Q
        autoRejected: 1,
        isOpen: true,
        isDeleted: false,
      });
      // A(1) + D(1) + L(1) + M(0.5) + O(1) + P(1) + Q(1) = 6.5h (K, N contribute 0).
      expect(open?.heldHours).toBeCloseTo(6.5, 8);

      const closed = body.venues.find((v) => v.venueId === venueClosedId);
      expect(closed).toMatchObject({
        requests: 0,
        heldHours: 0,
        isOpen: false,
      });
    });
  });

  describe('AC-O14 — Hub 3 identities', () => {
    it('department/purpose sums reconcile; registry length = discipline.lateCancellations', async () => {
      const body = (await operations(SUPER, rangeQs).expect(200)).body as {
        requests: { total: number };
        heldHours: number;
        discipline: { lateCancellations: number };
        departments: Array<{
          requests: number;
          heldHours: number;
          lateCancellations: number;
        }>;
        purposes: Array<{ requests: number; heldHours: number }>;
        registry: unknown[];
      };
      expect(body.requests.total).toBe(18);
      expect(body.heldHours).toBeCloseTo(7.5, 8);
      expect(body.discipline.lateCancellations).toBe(2);

      const deptReqSum = body.departments.reduce((s, d) => s + d.requests, 0);
      expect(deptReqSum).toBe(body.requests.total);
      const deptHeldSum = body.departments.reduce((s, d) => s + d.heldHours, 0);
      expect(deptHeldSum).toBeCloseTo(body.heldHours, 8);
      const deptLateSum = body.departments.reduce(
        (s, d) => s + d.lateCancellations,
        0,
      );
      expect(deptLateSum).toBe(body.discipline.lateCancellations);

      const purposeReqSum = body.purposes.reduce((s, p) => s + p.requests, 0);
      expect(purposeReqSum).toBe(body.requests.total);
      const purposeHeldSum = body.purposes.reduce((s, p) => s + p.heldHours, 0);
      expect(purposeHeldSum).toBeCloseTo(body.heldHours, 8);

      expect(body.registry).toHaveLength(body.discipline.lateCancellations);
    });
  });

  describe('AC-O7 — reserved-department fold (PDPA / no existence oracle)', () => {
    it('ADMIN sees no trace of the reserved department; SUPER_ADMIN sees its own row', async () => {
      const asAdminRaw = (await operations(ADMIN, rangeQs).expect(200)).text;
      expect(asAdminRaw).not.toContain(`${PREFIX}dept-reserved`);
      expect(asAdminRaw).not.toContain(`"departmentId":${deptReservedId}`);

      const asAdmin = JSON.parse(asAdminRaw) as {
        departments: Array<{ departmentId: number | null; heldHours: number }>;
      };
      const nullRow = asAdmin.departments.find((d) => d.departmentId === null);
      // Q (1h, unassigned) + O (1h, reserved, folded) = 2h.
      expect(nullRow?.heldHours).toBeCloseTo(2, 8);

      const asSuper = (await operations(SUPER, rangeQs).expect(200)).body as {
        departments: Array<{ departmentId: number | null; heldHours: number }>;
      };
      const reservedRow = asSuper.departments.find(
        (d) => d.departmentId === deptReservedId,
      );
      expect(reservedRow?.heldHours).toBeCloseTo(1, 8);
    });
  });

  describe('AC-O10 — SLA calculator on the fixture', () => {
    it('partitions exhaustively with the exact fixture numbers', async () => {
      const body = (await operations(SUPER, rangeQs).expect(200)).body as {
        requests: { total: number };
        sla: {
          decided: number;
          decidedApproved: number;
          decidedRejected: number;
          averageHours: number;
          medianHours: number;
          withinSla: number;
          withinSlaPercent: number;
          excluded: {
            autoRejected: number;
            withdrawn: number;
            staffCreated: number;
            expired: number;
            pending: number;
          };
        };
      };
      const { sla } = body;
      expect(sla.decided).toBe(5); // A, B, E, I, J
      expect(sla.decidedApproved).toBe(4); // A, E, I, J
      expect(sla.decidedRejected).toBe(1); // B
      expect(sla.excluded.autoRejected).toBe(1); // C
      expect(sla.excluded.withdrawn).toBe(1); // F
      expect(sla.excluded.expired).toBe(1); // G
      expect(sla.excluded.pending).toBe(1); // H
      expect(
        sla.decided +
          sla.excluded.autoRejected +
          sla.excluded.withdrawn +
          sla.excluded.staffCreated +
          sla.excluded.expired +
          sla.excluded.pending,
      ).toBe(body.requests.total);
      // Turnarounds: A=3h, B=30h, E=1h, I=2h, J=0h (created==approved) -> (3+30+1+2+0)/5 = 7.2h.
      expect(sla.averageHours).toBeCloseTo(7.2, 8);
      expect(sla.medianHours).toBeCloseTo(2, 8);
      expect(sla.withinSla).toBe(4);
      expect(sla.withinSlaPercent).toBeCloseTo(80, 8);
    });
  });

  describe('AC-O12 — late-cancellation registry', () => {
    it('has exactly 2 rows: before-start (10 min) and after-start (15 min)', async () => {
      const body = (await operations(SUPER, rangeQs).expect(200)).body as {
        registry: Array<{
          code: string;
          minutes: number;
          cancelledAfterStart: boolean;
          canceller: string;
        }>;
      };
      expect(body.registry).toHaveLength(2);
      const before = body.registry.find((r) => !r.cancelledAfterStart);
      const after = body.registry.find((r) => r.cancelledAfterStart);
      expect(before?.minutes).toBe(10);
      expect(before?.canceller).toBe('STAFF');
      expect(after?.minutes).toBe(15);
      expect(after?.canceller).toBe('REQUESTER');
    });
  });

  describe('AC-O13 — PDPA regex over the raw response, every role', () => {
    it.each([SUPER, ADMIN, VIEWER])(
      'no PII in the raw JSON as %s',
      async (who) => {
        const raw = (await operations(who, rangeQs).expect(200)).text;
        expect(raw).not.toMatch(
          /requesterName|contactPhone|"phone"|firstName|lastName|lineUserId|"U[0-9a-f]{20,}"/i,
        );
      },
    );
  });

  describe('Resolver parity — Hub 1 ?departmentId= matches Hub 3s row', () => {
    it('the ordinary department totals agree', async () => {
      const hub1 = (
        await overview(
          SUPER,
          `${rangeQs}&departmentId=${deptOrdinaryId}`,
        ).expect(200)
      ).body as { requests: { total: number } };
      const hub3 = (await operations(SUPER, rangeQs).expect(200)).body as {
        departments: Array<{ departmentId: number | null; requests: number }>;
      };
      const row = hub3.departments.find(
        (d) => d.departmentId === deptOrdinaryId,
      );
      expect(row?.requests).toBe(hub1.requests.total);
      expect(row?.requests).toBe(15); // A..N (14) + R (1)
    });
  });
});
