import type { INestApplication } from '@nestjs/common';
import { BookingStatus, SystemRole, type AppSetting } from '@prisma/client';
import ExcelJS from 'exceljs';
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
 * Reports Phase 3, Hub 4 (ส่งออกรายงานราชการ): AC-E1, AC-E6 to AC-E8, AC-E10 (backend side).
 * Runs against the real dev DB, so every figure is asserted over a WINDOW verified empty of real data
 * before seeding (`beforeAll` throws otherwise), and every row is removed by prefix in `afterAll`.
 */

const PREFIX = 'e2e-rpt3x-';
const PASSWORD = 'E2e-correct-horse-battery-1';
const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;

const url = (path: string) => `${API_BASE_PATH}${path}`;
const bkk = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - 7 * 3_600_000);

const WINDOW_START = '2020-01-06';
const WINDOW_END = '2020-04-30';
const LEAD_MINUTES_KEY = 'booking.cancel_lead_minutes';
const HOUR_MS = 3_600_000;
const EVIL = '=HYPERLINK("http://evil.example","click")';
const REGISTERED_FIRST = 'สมชายลับ';
const REGISTERED_PHONE = '0812345678';

interface Session {
  agent: request.Agent;
  token: string;
}

interface DocCell {
  text: string;
  value: number | null;
  numFmt: string | null;
}
interface DocBody {
  isEmpty: boolean;
  template: string;
  fileName: string;
  header: Record<string, string>;
  footer: string;
  sections: Array<{
    title: string;
    columns: Array<{ label: string; align: string }>;
    rows: Array<{ cells: DocCell[] }>;
    emptyText: string;
  }>;
}

describe('Reports Hub 4 export (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};
  let leadSnapshot: AppSetting | null = null;

  let venueOpenId = '';
  let venueClosedId = '';
  let venueDeletedId = '';
  let deptOrdinaryId = 0;
  let deptReservedId = 0;
  let liffPlainId = '';
  let liffRegisteredId = '';
  let creatorId = '';
  let codeSeq = 0;
  const codes: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];
  const qs = (template: string, extra = '', period = 'CUSTOM') =>
    `?template=${template}&period=${period}&startDate=${WINDOW_START}&endDate=${WINDOW_END}${extra}`;
  const docOf = async (email: string, template: string, extra = '') =>
    (
      await as(email)
        .agent.get(url(`/reports/export${qs(template, extra)}`))
        .expect(200)
    ).body as DocBody;

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
      `DELETE FROM line_user_registrations WHERE "lineUserId" IN (SELECT id FROM line_users WHERE "lineUserId" LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE name LIKE '${PREFIX}%'`,
    );
  };

  interface Spec {
    key: string;
    venueId?: string;
    departmentId?: number | null;
    user?: 'plain' | 'registered' | 'staff';
    status: BookingStatus;
    purpose?: string;
    rejectReason?: string | null;
    createdAt: Date;
    approvedAt?: Date | null;
    updatedAt?: Date;
    slots?: Array<{
      startAt: Date;
      endAt: Date;
      isCancelled?: boolean;
      cancelledAt?: Date | null;
      cancelledByRole?: string | null;
    }>;
  }

  const mk = async (spec: Spec) => {
    const slots = spec.slots ?? [];
    const firstStartAt = slots[0]?.startAt ?? spec.createdAt;
    const lastEndAt = slots[slots.length - 1]?.endAt ?? firstStartAt;
    const staff = (spec.user ?? 'plain') === 'staff';
    const venueId = spec.venueId ?? venueOpenId;
    const created = await prisma.bookingRequest.create({
      data: {
        code: `${PREFIX}${spec.key}-${String(++codeSeq).padStart(4, '0')}`,
        venueId,
        departmentId:
          spec.departmentId === undefined ? null : spec.departmentId,
        lineUserId: staff
          ? null
          : spec.user === 'registered'
            ? liffRegisteredId
            : liffPlainId,
        createdById: staff ? creatorId : null,
        approvedById: staff && spec.approvedAt ? creatorId : null,
        purpose: spec.purpose ?? 'ทดสอบ Reports Phase 3 e2e',
        attendees: 5,
        status: spec.status,
        rejectReason: spec.rejectReason ?? null,
        approvedAt: spec.approvedAt ?? null,
        firstStartAt,
        lastEndAt,
        createdAt: spec.createdAt,
        slots: slots.length
          ? {
              create: slots.map((s) => ({
                venueId,
                startAt: s.startAt,
                endAt: s.endAt,
                isCancelled: s.isCancelled ?? false,
                cancelledAt: s.cancelledAt ?? null,
                cancelledByRole: s.cancelledByRole ?? null,
              })),
            }
          : undefined,
      },
      select: { id: true, code: true },
    });
    if (spec.updatedAt) {
      await prisma.$executeRaw`UPDATE booking_requests SET "updatedAt" = ${spec.updatedAt} WHERE id = ${created.id}`;
    }
    codes[spec.key] = created.code;
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
        `reports-export.e2e-spec: window ${WINDOW_START}..${WINDOW_END} is NOT empty (requests=${existingRequests}, slots=${existingSlots}); refusing to seed on top of real data.`,
      );
    }

    leadSnapshot = await prisma.appSetting.findUnique({
      where: { key: LEAD_MINUTES_KEY },
    });
    await prisma.appSetting.upsert({
      where: { key: LEAD_MINUTES_KEY },
      create: { key: LEAD_MINUTES_KEY, value: '30' },
      update: { value: '30' },
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
        data: {
          name: `${PREFIX}deleted`,
          venueTypeId: typeId,
          capacity: 30,
          deletedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
    deptOrdinaryId = (
      await prisma.department.create({
        data: { name: `${PREFIX}dept` },
        select: { id: true },
      })
    ).id;
    deptReservedId = (
      await prisma.department.create({
        data: { name: `${PREFIX}dept-reserved`, isSystemReserved: true },
        select: { id: true },
      })
    ).id;

    const options = await ensureE2eOptions(prisma);
    liffPlainId = (
      await prisma.lineUser.create({
        data: { lineUserId: `${PREFIX}Uplain00000000000000000000000` },
        select: { id: true },
      })
    ).id;
    liffRegisteredId = (
      await prisma.lineUser.create({
        data: {
          lineUserId: `${PREFIX}Ureg0000000000000000000000000`,
          registration: {
            create: {
              firstName: REGISTERED_FIRST,
              lastName: 'นามสกุลลับ',
              phone: '081-234-5678',
              phoneDigits: REGISTERED_PHONE,
              departmentId: deptOrdinaryId,
              personnelRoleId: options.personnelRoleId,
            },
          },
        },
        select: { id: true },
      })
    ).id;

    const passwordHash = await new PasswordService().hash(PASSWORD);
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
    ] as Array<[string, SystemRole]>) {
      const u = await prisma.systemUser.create({
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
      if (email === SUPER) creatorId = u.id;
    }
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER])
      sessions[email] = await login(email);

    // ── fixture ───────────────────────────────────────────────────────────────────────────────────
    await mk({
      key: 'a',
      departmentId: deptOrdinaryId,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 6, 6),
      approvedAt: bkk(2020, 1, 6, 9),
      slots: [{ startAt: bkk(2020, 1, 6, 9), endAt: bkk(2020, 1, 6, 10) }],
    });
    await mk({
      key: 'b',
      departmentId: deptOrdinaryId,
      status: BookingStatus.REJECTED,
      purpose: EVIL,
      rejectReason: 'ไม่เหมาะสมกับสถานที่',
      createdAt: bkk(2020, 1, 7, 6),
      updatedAt: new Date(bkk(2020, 1, 7, 6).getTime() + 30 * HOUR_MS),
    });
    await mk({
      key: 'c',
      departmentId: deptOrdinaryId,
      status: BookingStatus.REJECTED,
      rejectReason: AUTO_REJECTED_REASON,
      createdAt: bkk(2020, 1, 8, 6),
    });
    await mk({
      key: 'd',
      user: 'staff',
      departmentId: deptOrdinaryId,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 9, 9),
      approvedAt: bkk(2020, 1, 9, 9),
      slots: [
        { startAt: bkk(2020, 1, 9, 10), endAt: bkk(2020, 1, 9, 11) },
        { startAt: bkk(2020, 1, 16, 10), endAt: bkk(2020, 1, 16, 11) },
      ],
    });
    await mk({
      key: 'e',
      user: 'registered',
      status: BookingStatus.CANCELLED,
      createdAt: bkk(2020, 1, 10, 9),
      approvedAt: bkk(2020, 1, 10, 10),
      slots: [
        {
          startAt: bkk(2020, 1, 10, 10),
          endAt: bkk(2020, 1, 10, 11),
          isCancelled: true,
          cancelledAt: bkk(2020, 1, 10, 9, 50),
          cancelledByRole: 'ADMIN',
        },
      ],
    });
    await mk({
      key: 'g',
      departmentId: deptOrdinaryId,
      status: BookingStatus.EXPIRED,
      createdAt: bkk(2020, 1, 14, 9),
    });
    await mk({
      key: 'h',
      departmentId: deptOrdinaryId,
      status: BookingStatus.PENDING,
      createdAt: bkk(2020, 1, 15, 9),
    });
    await mk({
      key: 'r',
      departmentId: deptReservedId,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 20, 8),
      approvedAt: bkk(2020, 1, 20, 9),
      slots: [{ startAt: bkk(2020, 1, 20, 13), endAt: bkk(2020, 1, 20, 14) }],
    });
    await mk({
      key: 'v',
      venueId: venueClosedId,
      departmentId: deptOrdinaryId,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 21, 8),
      approvedAt: bkk(2020, 1, 21, 9),
      slots: [{ startAt: bkk(2020, 1, 21, 9), endAt: bkk(2020, 1, 21, 11) }],
    });
    await mk({
      key: 'x',
      venueId: venueDeletedId,
      departmentId: deptOrdinaryId,
      status: BookingStatus.APPROVED,
      createdAt: bkk(2020, 1, 22, 8),
      approvedAt: bkk(2020, 1, 22, 9),
      slots: [{ startAt: bkk(2020, 1, 22, 9), endAt: bkk(2020, 1, 22, 10) }],
    });
  });

  afterAll(async () => {
    await purgeRows();
    await purgeE2eUsers(prisma, PREFIX);
    if (leadSnapshot) {
      await prisma.appSetting.update({
        where: { key: LEAD_MINUTES_KEY },
        data: { value: leadSnapshot.value },
      });
    } else {
      await prisma.appSetting.deleteMany({ where: { key: LEAD_MINUTES_KEY } });
    }
    await app.close();
  });

  // ── AC-E1: role matrix ────────────────────────────────────────────────────────────────────────────
  describe('AC-E1 role matrix', () => {
    const paths = () => [
      `/reports/export${qs('SUMMARY')}`,
      `/reports/export/xlsx${qs('SUMMARY')}`,
      `/reports/export/scope-options`,
    ];

    it.each([0, 1, 2])(
      'route #%i: 401 / VIEWER 403 / ADMIN 200 / SUPER_ADMIN 200',
      async (i) => {
        const p = url(paths()[i]);
        expect((await request(server()).get(p)).status).toBe(401);
        expect((await as(VIEWER).agent.get(p)).status).toBe(403);
        expect((await as(ADMIN).agent.get(p)).status).toBe(200);
        expect((await as(SUPER).agent.get(p)).status).toBe(200);
      },
    );

    it.each([
      ['a trailing slash', (p: string) => p.replace('?', '/?')],
      [
        'upper case',
        (p: string) => p.replace(/^\/reports\/export/, '/REPORTS/EXPORT'),
      ],
    ])(
      '%s answers like the canonical path and never skips @Roles',
      async (_l, mutate) => {
        for (const base of paths().slice(0, 2)) {
          const p = url(mutate(base));
          expect((await request(server()).get(p)).status).toBe(401);
          expect((await as(VIEWER).agent.get(p)).status).toBe(403);
          expect((await as(ADMIN).agent.get(p)).status).toBe(200);
        }
        const so = url(
          mutate('/reports/export/scope-options').replace(
            '/scope-options/',
            '/scope-options',
          ),
        );
        expect((await as(VIEWER).agent.get(so)).status).toBe(403);
      },
    );

    it('a doubled or encoded slash matches no route: 404 for every role, never a document', async () => {
      for (const v of [
        `/reports/export//${qs('SUMMARY')}`,
        `/reports//export${qs('SUMMARY')}`,
        `/reports/export%2Fxlsx${qs('SUMMARY')}`,
      ]) {
        for (const agent of [
          request(server()),
          as(VIEWER).agent,
          as(ADMIN).agent,
          as(SUPER).agent,
        ]) {
          const res = await (
            agent as unknown as {
              get: (u: string) => Promise<request.Response>;
            }
          ).get(url(v));
          expect(res.status).toBe(404);
          expect(res.body).not.toHaveProperty('sections');
        }
      }
    });
  });

  // ── coded 400s ───────────────────────────────────────────────────────────────────────────────────
  describe('validation', () => {
    const get = (q: string, email = ADMIN) =>
      as(email).agent.get(url(`/reports/export${q}`));
    const base = (extra = '') => qs('SUMMARY', extra);

    it('a missing, unknown or malformed parameter is the uncoded pipe 400', async () => {
      for (const q of [
        `?period=CUSTOM&startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
        base('&bogus=1'),
        `?template=NOPE&period=CUSTOM&startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
        `?template=SUMMARY&period=NOPE&startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
        base('&departmentId=abc'),
      ]) {
        const res = await get(q);
        expect(res.status).toBe(400);
        expect(res.body).not.toHaveProperty('code');
      }
    });

    it.each([
      [
        'an invalid date',
        `?template=SUMMARY&period=CUSTOM&startDate=2020-02-30&endDate=2020-03-01`,
        'REPORT_DATE_INVALID',
      ],
      [
        'an inverted range',
        `?template=SUMMARY&period=CUSTOM&startDate=2020-03-02&endDate=2020-03-01`,
        'REPORT_RANGE_INVERTED',
      ],
      [
        'a range over 366 days',
        `?template=SUMMARY&period=CUSTOM&startDate=2019-01-01&endDate=2020-03-01`,
        'REPORT_RANGE_TOO_WIDE',
      ],
      [
        'a TERM that is not a term',
        `?template=SUMMARY&period=TERM&startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
        'REPORT_PERIOD_MISMATCH',
      ],
      [
        'a MONTH that is not a month',
        `?template=SUMMARY&period=MONTH&startDate=2020-01-02&endDate=2020-01-31`,
        'REPORT_PERIOD_MISMATCH',
      ],
      [
        'an unknown venue',
        base('&venueId=no-such-venue'),
        'REPORT_VENUE_INVALID',
      ],
      [
        'an unknown department',
        base('&departmentId=999999999'),
        'REPORT_DEPARTMENT_INVALID',
      ],
    ])('%s is a coded 400', async (_l, q, code) => {
      const res = await get(q);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, code });
      expect((await get(q.replace('/reports', ''), SUPER)).status).toBe(400);
    });

    it('checks run in order: a bad range wins over a bad period and a bad venue', async () => {
      const res = await get(
        `?template=SUMMARY&period=TERM&startDate=2020-03-02&endDate=2020-03-01&venueId=nope`,
      );
      expect(res.body).toMatchObject({ code: 'REPORT_RANGE_INVERTED' });
    });

    it('a reserved department is the SAME 400 as an unknown one for ADMIN, and fine for SUPER_ADMIN', async () => {
      const reserved = await get(base(`&departmentId=${deptReservedId}`));
      const unknown = await get(base('&departmentId=999999999'));
      expect(reserved.status).toBe(400);
      expect(reserved.body).toEqual(unknown.body);
      expect(
        (await get(base(`&departmentId=${deptReservedId}`), SUPER)).status,
      ).toBe(200);
    });
  });

  // ── AC-E6: แบบ 1 equals the existing endpoints ───────────────────────────────────────────────────
  describe('AC-E6 แบบ 1 parity with /reports/overview, /operations and /venues', () => {
    interface Overview {
      requests: {
        total: number;
        approved: number;
        rejected: number;
        autoRejected: number;
        cancelled: number;
        expired: number;
        pending: number;
      };
      occupancy: {
        heldHours: number;
        schoolDays: number;
        occupancyPercent: number | null;
        venueCount: number;
      };
      discipline: { lateCancellations: number };
    }
    const overview = async (email: string, extra = '') =>
      (
        await as(email)
          .agent.get(
            url(
              `/reports/overview?startDate=${WINDOW_START}&endDate=${WINDOW_END}${extra}`,
            ),
          )
          .expect(200)
      ).body as Overview;
    const operations = async (email: string) =>
      (
        await as(email)
          .agent.get(
            url(
              `/reports/operations?startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
            ),
          )
          .expect(200)
      ).body as {
        sla: { averageHours: number | null; withinSlaPercent: number | null };
        departments: Array<{
          name: string | null;
          isDeleted: boolean;
          requests: number;
          heldHours: number;
        }>;
      };
    const venuesHub = async () =>
      (
        await as(ADMIN)
          .agent.get(
            url(
              `/reports/venues?startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
            ),
          )
          .expect(200)
      ).body as {
        venues: Array<{
          name: string;
          isDeleted: boolean;
          isOpen: boolean;
          requests: number;
          heldHours: number;
        }>;
      };

    it('the eight indicator rows equal Hub 1 and Hub 3 for the same range', async () => {
      const doc = await docOf(ADMIN, 'SUMMARY');
      const ov = await overview(ADMIN);
      const op = await operations(ADMIN);
      const rows = doc.sections[0].rows.map((r) => r.cells);
      expect(rows[0][1].value).toBe(ov.requests.total);
      expect(rows[1][1].value).toBe(ov.requests.approved);
      expect(rows[2][1].value).toBe(ov.requests.rejected);
      expect(rows[2][2].text).toContain(
        `เวลาชนกับการจองเดิม ${ov.requests.autoRejected} รายการ`,
      );
      expect(rows[3][1].value).toBe(ov.requests.cancelled);
      expect(rows[4][1].value).toBeCloseTo(ov.occupancy.heldHours, 8);
      expect(rows[4][2].text).toBe(`${ov.occupancy.schoolDays} วันทำการ`);
      expect(rows[5][1].value).not.toBeNull();
      expect((rows[5][1].value as number) * 100).toBeCloseTo(
        ov.occupancy.occupancyPercent as number,
        8,
      );
      expect(rows[6][1].value).toBe(ov.discipline.lateCancellations);
      expect(rows[7][1].value).toBeCloseTo(op.sla.averageHours as number, 8);
      expect(ov.requests.total).toBe(10);
    });

    it('known fixture totals', async () => {
      const ov = await overview(ADMIN);
      expect(ov.requests).toMatchObject({
        approved: 5,
        rejected: 2,
        autoRejected: 1,
        cancelled: 1,
        expired: 1,
        pending: 1,
      });
      expect(ov.discipline.lateCancellations).toBe(1);
    });

    it('the venue and department tables equal Hub 2 and Hub 3 (reserved folded for ADMIN)', async () => {
      const doc = await docOf(ADMIN, 'SUMMARY');
      const hub2 = (await venuesHub()).venues;
      const venueRows = doc.sections[1].rows.map(
        (r) => [r.cells[1].text, r.cells[2].value, r.cells[3].value] as const,
      );
      expect(venueRows).toHaveLength(hub2.length);
      hub2.forEach((v, i) => {
        expect(venueRows[i][0]).toBe(v.name);
        expect(venueRows[i][1]).toBe(v.requests);
        expect(venueRows[i][2]).toBeCloseTo(v.heldHours, 8);
      });
      const hub3 = (await operations(ADMIN)).departments;
      const deptRows = doc.sections[2].rows.map(
        (r) => [r.cells[1].text, r.cells[2].value, r.cells[3].value] as const,
      );
      expect(deptRows).toHaveLength(hub3.length);
      hub3.forEach((d, i) => {
        expect(deptRows[i][0]).toBe(
          d.name === null
            ? 'ไม่ระบุกลุ่ม/ฝ่าย'
            : `${d.name}${d.isDeleted ? ' (ลบแล้ว)' : ''}`,
        );
        expect(deptRows[i][1]).toBe(d.requests);
        expect(deptRows[i][2]).toBeCloseTo(d.heldHours, 8);
      });
    });

    it('a venue scope equals /reports/overview?venueId= and a department scope equals ?departmentId=', async () => {
      const byVenue = await docOf(
        ADMIN,
        'SUMMARY',
        `&venueId=${venueClosedId}`,
      );
      const ovVenue = await overview(ADMIN, `&venueId=${venueClosedId}`);
      expect(byVenue.sections[0].rows[0].cells[1].value).toBe(
        ovVenue.requests.total,
      );
      expect(byVenue.sections[0].rows[4].cells[1].value).toBeCloseTo(
        ovVenue.occupancy.heldHours,
        8,
      );
      expect(byVenue.header.scope).toBe(
        `สำหรับขอบเขตข้อมูลสถานที่${PREFIX}closed และกลุ่มสาระและฝ่ายงานทั้งหมด`,
      );
      expect(byVenue.sections[1].rows).toHaveLength(1);

      const byDept = await docOf(
        SUPER,
        'SUMMARY',
        `&departmentId=${deptReservedId}`,
      );
      const ovDept = await overview(SUPER, `&departmentId=${deptReservedId}`);
      expect(byDept.sections[0].rows[0].cells[1].value).toBe(
        ovDept.requests.total,
      );
      expect(byDept.sections[0].rows[0].cells[1].value).toBe(1);
      expect(byDept.sections[2].rows).toHaveLength(1);
      expect(byDept.sections[2].rows[0].cells[1].text).toBe(
        `${PREFIX}dept-reserved`,
      );
    });

    it('the header carries the PO form of dates, the period line, the PO template name and the file name', async () => {
      const doc = await docOf(ADMIN, 'SUMMARY');
      expect(doc.header.dateRange).toBe(
        'ข้อมูลระหว่างวันที่ 6 ม.ค. 2563 ถึงวันที่ 30 เม.ย. 2563',
      );
      expect(doc.header.period).toBe(
        'ระหว่างวันที่ 6 ม.ค. 2563 ถึงวันที่ 30 เม.ย. 2563',
      );
      expect(doc.header.kind).toBe('(แบบ 1 สรุปภาพรวม)');
      expect(doc.fileName).toBe(
        `easybook-report-summary_${WINDOW_START}_${WINDOW_END}.xlsx`,
      );
      expect(doc.footer).toMatch(
        /^ข้อมูล ณ วันที่ \d{1,2} [ก-๙.]+ 25\d{2} เอกสารออกโดยระบบ EasyBook$/,
      );
    });

    it('a TERM period with the exact term bounds is labelled by the server', async () => {
      const res = await as(ADMIN)
        .agent.get(
          url(
            '/reports/export?template=SUMMARY&period=TERM&startDate=2020-05-16&endDate=2020-10-31',
          ),
        )
        .expect(200);
      expect((res.body as DocBody).header.period).toBe(
        'ประจำภาคเรียนที่ 1 ปีการศึกษา 2563',
      );
      const month = await as(ADMIN)
        .agent.get(
          url(
            '/reports/export?template=LEDGER&period=MONTH&startDate=2020-02-01&endDate=2020-02-29',
          ),
        )
        .expect(200);
      expect((month.body as DocBody).header.period).toBe(
        'ประจำเดือนกุมภาพันธ์ พ.ศ. 2563',
      );
    });
  });

  // ── AC-E7: แบบ 2 ──────────────────────────────────────────────────────────────────────────────────
  describe('AC-E7 แบบ 2 ledger', () => {
    it('has one row per attributed request, ordered by first use then code, with the right statuses', async () => {
      const doc = await docOf(ADMIN, 'LEDGER');
      const ov = (
        await as(ADMIN)
          .agent.get(
            url(
              `/reports/overview?startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
            ),
          )
          .expect(200)
      ).body as { requests: { total: number } };
      const rows = doc.sections[0].rows.map((r) => r.cells.map((c) => c.text));
      expect(rows).toHaveLength(ov.requests.total);
      expect(rows.map((r) => r[0])).toEqual(rows.map((_r, i) => String(i + 1)));
      const byCode = new Map(rows.map((r) => [r[1], r]));
      const status = (key: string) => byCode.get(codes[key])?.[6];
      expect(status('a')).toBe('อนุมัติแล้ว');
      expect(status('b')).toBe('ปฏิเสธ');
      expect(status('c')).toBe('ปฏิเสธ (เวลาชน)');
      expect(status('d')).toBe('อนุมัติแล้ว');
      expect(status('e')).toBe('ยกเลิกกระชั้นชิด');
      expect(status('g')).toBe('หมดอายุ');
      expect(status('h')).toBe('รอพิจารณา');
      // First-use order: a (6 Jan) before d (9 Jan) before r (20 Jan).
      const order = rows.map((r) => r[1]);
      expect(order.indexOf(codes.a)).toBeLessThan(order.indexOf(codes.d));
      expect(order.indexOf(codes.d)).toBeLessThan(order.indexOf(codes.r));
    });

    it('prints the use date with Bangkok clock times and the weekly suffix', async () => {
      const rows = (await docOf(ADMIN, 'LEDGER')).sections[0].rows.map((r) =>
        r.cells.map((c) => c.text),
      );
      const byCode = new Map(rows.map((r) => [r[1], r]));
      expect(byCode.get(codes.a)?.[2]).toBe(
        '6 ม.ค. 2563 เวลา 09.00 น. ถึง 10.00 น.',
      );
      expect(byCode.get(codes.d)?.[2]).toBe(
        '9 ม.ค. 2563 เวลา 10.00 น. ถึง 11.00 น. (ทุกสัปดาห์ จำนวน 2 สัปดาห์)',
      );
    });

    it('passes the purpose through raw and types it as a string cell', async () => {
      const doc = await docOf(ADMIN, 'LEDGER');
      const row = doc.sections[0].rows.find((r) => r.cells[1].text === codes.b);
      expect(row?.cells[5]).toEqual({ text: EVIL, value: null, numFmt: null });
    });

    it('folds the reserved department for ADMIN and names it for SUPER_ADMIN', async () => {
      const find = (d: DocBody) =>
        d.sections[0].rows.find((r) => r.cells[1].text === codes.r)?.cells[4]
          .text;
      expect(find(await docOf(ADMIN, 'LEDGER'))).toBe('ไม่ระบุกลุ่ม/ฝ่าย');
      expect(find(await docOf(SUPER, 'LEDGER'))).toBe(`${PREFIX}dept-reserved`);
    });

    it("takes a registered requester's department but never their name, phone, e-mail or LINE id (regex over the raw JSON)", async () => {
      for (const email of [ADMIN, SUPER]) {
        for (const template of ['SUMMARY', 'LEDGER', 'VENUES']) {
          const raw = JSON.stringify(await docOf(email, template));
          expect(raw).not.toContain(REGISTERED_FIRST);
          expect(raw).not.toContain('นามสกุลลับ');
          expect(raw).not.toContain(REGISTERED_PHONE);
          expect(raw).not.toContain('081-234-5678');
          expect(raw).not.toMatch(/U[0-9a-f]{32}/);
          expect(raw).not.toContain(`${PREFIX}U`);
          expect(raw).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
          expect(raw).not.toMatch(
            /requesterName|contactPhone|lineUserId|passwordHash/,
          );
        }
      }
      const ledger = await docOf(ADMIN, 'LEDGER');
      const e = ledger.sections[0].rows.find(
        (r) => r.cells[1].text === codes.e,
      );
      expect(e?.cells[4].text).toBe(`${PREFIX}dept`); // the registration's department
    });

    it('never leaks the reserved department to ADMIN anywhere in any template or scope-options', async () => {
      for (const template of ['SUMMARY', 'LEDGER', 'VENUES']) {
        expect(JSON.stringify(await docOf(ADMIN, template))).not.toContain(
          `${PREFIX}dept-reserved`,
        );
      }
      const so = (
        await as(ADMIN)
          .agent.get(url('/reports/export/scope-options'))
          .expect(200)
      ).body as {
        departments: Array<{ id: number; name: string }>;
      };
      expect(so.departments.map((d) => d.id)).not.toContain(deptReservedId);
      const soSa = (
        await as(SUPER)
          .agent.get(url('/reports/export/scope-options'))
          .expect(200)
      ).body as typeof so;
      expect(soSa.departments.map((d) => d.id)).toContain(deptReservedId);
      expect(JSON.stringify(await docOf(SUPER, 'SUMMARY'))).toContain(
        `${PREFIX}dept-reserved`,
      );
    });
  });

  // ── AC-E8: แบบ 3 ──────────────────────────────────────────────────────────────────────────────────
  describe('AC-E8 แบบ 3 per venue', () => {
    it('Σ hours equals แบบ 1, rows are by hours desc, and venues are decorated', async () => {
      const venues = await docOf(ADMIN, 'VENUES');
      const summary = await docOf(ADMIN, 'SUMMARY');
      const rows = venues.sections[0].rows.map((r) => r.cells);
      const sum = rows.reduce((s, c) => s + (c[3].value ?? 0), 0);
      expect(sum).toBeCloseTo(
        summary.sections[0].rows[4].cells[1].value as number,
        8,
      );
      const hours = rows.map((c) => c[3].value as number);
      expect(hours).toEqual([...hours].sort((a, b) => b - a));
      const names = rows.map((c) => c[1].text);
      expect(names).toContain(`${PREFIX}open`);
      expect(names).toContain(`${PREFIX}closed (ปิดให้จอง)`);
      expect(names).toContain(`${PREFIX}deleted (ลบแล้ว)`);
      const open = rows.find((c) => c[1].text === `${PREFIX}open`) as DocCell[];
      expect(open[2].text).toBe(`${PREFIX}hall ความจุ 50 คน`);
      expect(open[7].text).toMatch(
        /^วัน(จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์) เวลา \d{2}\.\d{2} น\.$/,
      );
      expect(open[8].text).toMatch(/\(\d+%\)$/);
    });

    it('the main user folds the reserved department for ADMIN', async () => {
      // Venue "open" holds a (ordinary) and r (reserved): ordinary has 1 h, reserved 1 h; for ADMIN the
      // reserved bucket is NULL and is never a main user.
      const open = (d: DocBody) =>
        d.sections[0].rows.find((r) => r.cells[1].text === `${PREFIX}open`)
          ?.cells[8].text;
      expect(open(await docOf(ADMIN, 'VENUES'))).not.toContain('reserved');
      expect(open(await docOf(SUPER, 'VENUES'))).toMatch(/^(.+) \(\d+%\)$/);
    });
  });

  // ── empty window ─────────────────────────────────────────────────────────────────────────────────
  it('a range with no data (or entirely in the future) is isEmpty with empty tables, never a 400', async () => {
    const past = await as(ADMIN)
      .agent.get(
        url(
          '/reports/export?template=SUMMARY&period=CUSTOM&startDate=2001-01-01&endDate=2001-01-31',
        ),
      )
      .expect(200);
    expect((past.body as DocBody).isEmpty).toBe(true);
    const future = await as(ADMIN)
      .agent.get(
        url(
          '/reports/export?template=LEDGER&period=CUSTOM&startDate=2999-01-01&endDate=2999-01-31',
        ),
      )
      .expect(200);
    expect((future.body as DocBody).isEmpty).toBe(true);
    expect((future.body as DocBody).sections[0].rows).toHaveLength(0);
    expect((future.body as DocBody).sections[0].emptyText).toBe(
      'ไม่มีรายการในช่วงเวลาและขอบเขตที่เลือก',
    );
  });

  // ── AC-E10: .xlsx ────────────────────────────────────────────────────────────────────────────────
  describe('AC-E10 .xlsx', () => {
    const binary = (
      r: request.Response,
      cb: (err: Error | null, body: Buffer) => void,
    ) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const xlsx = (template: string, email = ADMIN) =>
      as(email)
        .agent.get(url(`/reports/export/xlsx${qs(template)}`))
        .buffer(true)
        .parse(binary);

    it.each(['SUMMARY', 'LEDGER', 'VENUES'])(
      '%s: headers and a workbook that equals the JSON model',
      async (template) => {
        const res = await xlsx(template).expect(200);
        expect(res.headers['content-type']).toBe(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        expect(res.headers['content-disposition']).toBe(
          `attachment; filename="easybook-report-${template.toLowerCase()}_${WINDOW_START}_${WINDOW_END}.xlsx"`,
        );
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-content-type-options']).toBe('nosniff');

        const model = await docOf(ADMIN, template);
        const wb = new ExcelJS.Workbook();
        const bytes = res.body as Buffer;
        await wb.xlsx.load(bytes as unknown as ArrayBuffer);
        const ws = wb.worksheets[0];
        expect(ws.getCell(1, 1).value).toBe(model.header.title);
        expect(ws.getCell(3, 1).value).toBe(model.header.period);
        let r = 8; // 6 header lines + one blank row, then the first section title
        for (const section of model.sections) {
          expect(ws.getCell(r, 1).value).toBe(
            `${model.sections.indexOf(section) + 1}. ${section.title}`,
          );
          r += 2;
          if (section.rows.length === 0) r += 1;
          for (const row of section.rows) {
            row.cells.forEach((cell, ci) => {
              const got = ws.getCell(r, ci + 1).value;
              if (cell.value !== null) expect(got).toBe(cell.value);
              else expect(got).toBe(cell.text);
            });
            r += 1;
          }
          r += 1;
        }
        expect(ws.getCell(r, 1).value).toBe(model.footer);
      },
    );

    it('stores the =HYPERLINK purpose as an inert string cell', async () => {
      const res = await xlsx('LEDGER').expect(200);
      const wb = new ExcelJS.Workbook();
      const bytes = res.body as Buffer;
      await wb.xlsx.load(bytes as unknown as ArrayBuffer);
      let found: ExcelJS.Cell | undefined;
      wb.worksheets[0].eachRow((row) =>
        row.eachCell((c) => {
          if (c.value === EVIL) found = c;
        }),
      );
      expect(found?.type).toBe(ExcelJS.ValueType.String);
      expect(found?.formula).toBeUndefined();
    });

    it('answers a coded JSON 400 (not a broken file) for a bad request', async () => {
      const res = await as(ADMIN).agent.get(
        url(
          '/reports/export/xlsx?template=SUMMARY&period=TERM&startDate=2020-01-06&endDate=2020-04-30',
        ),
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'REPORT_PERIOD_MISMATCH' });
    });
  });

  // ── scope-options ────────────────────────────────────────────────────────────────────────────────
  it('scope-options lists every venue (deleted flagged) Thai-sorted, with no PII', async () => {
    const so = (
      await as(SUPER)
        .agent.get(url('/reports/export/scope-options'))
        .expect(200)
    ).body as {
      venues: Array<{
        id: string;
        name: string;
        isDeleted: boolean;
        isOpen: boolean;
      }>;
    };
    const mine = so.venues.filter((v) => v.name.startsWith(PREFIX));
    expect(mine.find((v) => v.id === venueDeletedId)).toMatchObject({
      isDeleted: true,
    });
    expect(mine.find((v) => v.id === venueClosedId)).toMatchObject({
      isOpen: false,
      isDeleted: false,
    });
    const names = so.venues.map((v) => v.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'th')));
    expect(JSON.stringify(so)).not.toMatch(/phone|email|lineUserId/i);
  });

  it('ADMIN-only data stays out of the response keys: no requester fields in any model', async () => {
    const raw = JSON.stringify(await docOf(SUPER, 'LEDGER'));
    expect(raw).not.toMatch(
      /"(requesterName|contactPhone|firstName|lastName|phone)"/,
    );
  });
});
