import type { INestApplication } from '@nestjs/common';
import { BookingStatus, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import {
  AUTO_EXPIRED_REASON,
  AUTO_REJECTED_REASON,
} from '../src/bookings/bookings.constants';
import { API_BASE_PATH } from '../src/common/api.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { dayStart } from '../src/reports/report-calendar';
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
 * Reports Phase 3, Hub 5 (ประวัติการทำรายการ): AC-A1, AC-A3 to AC-A7, AC-A9, AC-A10 (backend side).
 *
 * There is no audit table (PO ruling OQ-P3-1): events are synthesised from existing columns. Runs against
 * the real dev DB, so each scenario owns a calendar window in 2021 that `beforeAll` verifies is EMPTY of
 * real events before seeding, and every fixture row is removed by prefix in `afterAll`.
 */

const PREFIX = 'e2e-rpt3a-';
const PASSWORD = 'E2e-correct-horse-battery-1';
const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;
const url = (path: string) => `${API_BASE_PATH}${path}`;
const bkk = (y: number, m: number, d: number, hh = 0, mm = 0, ss = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - 7 * 3_600_000);

// One window per scenario (all inside 2021-03-01 .. 2021-08-03, verified empty before seeding).
const MAIN = 'startDate=2021-03-01&endDate=2021-03-30';
const TIES = 'startDate=2021-05-10&endDate=2021-05-10';
const EDGE_LAST = 'startDate=2021-06-30&endDate=2021-06-30';
const EDGE_NEXT = 'startDate=2021-07-01&endDate=2021-07-01';
const STATES = 'startDate=2021-08-02&endDate=2021-08-02';

interface Session {
  agent: request.Agent;
  token: string;
}

interface Event {
  id: string;
  at: string;
  atIsApproximate: boolean;
  action: string;
  actor: null | {
    id: string | null;
    name: string | null;
    role: string | null;
    position: string | null;
    department: string | null;
    state: string;
  };
  target: {
    kind: string;
    id: string | null;
    label: string;
    detail: string | null;
    isDeleted: boolean;
  };
  summary: string;
  changes: Array<{ field: string; before: string; after: string }> | null;
  note: string | null;
  ip: string | null;
  userAgent: string | null;
}

describe('Reports Hub 5 activity (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};

  let venueId = '';
  let deptId = 0;
  let deptReservedId = 0;
  let liffId = '';
  let saId = '';
  let adminId = '';
  let softDeletedId = '';
  let reservedStaffId = '';
  let createdStaffId = '';
  let codeSeq = 0;
  const codes: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];
  const page = async (email: string, window: string, extra = '') =>
    (
      await as(email)
        .agent.get(url(`/reports/activity?${window}${extra}`))
        .expect(200)
    ).body as {
      items: Event[];
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      capabilities: {
        source: string;
        actions: string[];
        recordsIp: boolean;
        recordsResourceChanges: boolean;
      };
      range: { startDate: string; endDate: string; days: number };
    };
  const kpis = async (email: string, window: string) =>
    (
      await as(email)
        .agent.get(url(`/reports/activity/kpis?${window}`))
        .expect(200)
    ).body as {
      kpis: {
        total: number;
        days: number;
        approve: number;
        reject: number;
        cancel: number;
        directBooking: number;
        resourceChanges: number | null;
        topActor: null | {
          actor: { id: string };
          count: number;
          percent: number;
        };
      };
    };

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
      `DELETE FROM announcements WHERE title LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE name LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE name LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${PREFIX}%'`,
    );
    await purgeE2eUsers(prisma, PREFIX);
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE name LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM personnel_roles WHERE name LIKE '${PREFIX}%'`,
    );
  };

  interface Req {
    key: string;
    status?: BookingStatus;
    code?: string;
    approvedAt?: Date | null;
    approvedById?: string | null;
    createdById?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
    rejectReason?: string | null;
    departmentId?: number | null;
    slots?: Array<{
      startAt: Date;
      endAt: Date;
      isCancelled?: boolean;
      cancelledAt?: Date | null;
      cancelledById?: string | null;
      cancelledByRole?: string | null;
      cancelReason?: string | null;
    }>;
  }

  const mk = async (r: Req) => {
    const slots = r.slots ?? [];
    const first = slots[0]?.startAt ?? bkk(2022, 1, 3, 9);
    const created = await prisma.bookingRequest.create({
      data: {
        code:
          r.code ?? `${PREFIX}${r.key}-${String(++codeSeq).padStart(4, '0')}`,
        venueId,
        departmentId: r.departmentId === undefined ? deptId : r.departmentId,
        lineUserId: r.createdById ? null : liffId,
        createdById: r.createdById ?? null,
        approvedById: r.approvedById ?? null,
        purpose: 'ทดสอบ Reports Phase 3 activity',
        attendees: 5,
        status: r.status ?? BookingStatus.APPROVED,
        rejectReason: r.rejectReason ?? null,
        approvedAt: r.approvedAt ?? null,
        firstStartAt: first,
        lastEndAt: slots[slots.length - 1]?.endAt ?? first,
        // Far before every window, so a LIFF row is never itself an event unless a test says so.
        createdAt: r.createdAt ?? bkk(2021, 1, 4, 9),
        slots: slots.length
          ? {
              create: slots.map((s) => ({
                venueId,
                startAt: s.startAt,
                endAt: s.endAt,
                isCancelled: s.isCancelled ?? false,
                cancelledAt: s.cancelledAt ?? null,
                cancelledById: s.cancelledById ?? null,
                cancelledByRole: s.cancelledByRole ?? null,
                cancelReason: s.cancelReason ?? null,
              })),
            }
          : undefined,
      },
      select: { id: true, code: true },
    });
    // @updatedAt would otherwise be "now": force it (far before every window unless given).
    const updatedAt = r.updatedAt ?? bkk(2021, 1, 4, 9);
    await prisma.$executeRaw`UPDATE booking_requests SET "updatedAt" = ${updatedAt} WHERE id = ${created.id}`;
    codes[r.key] = created.code;
    return created;
  };

  const staff = async (
    email: string,
    over: {
      role?: SystemRole;
      first?: string;
      last?: string;
      createdById?: string | null;
      createdAt?: Date;
      deletedAt?: Date | null;
      departmentId?: number;
      personnelRoleId?: number;
    } = {},
  ) => {
    const options = await ensureE2eOptions(prisma);
    const passwordHash = await new PasswordService().hash(PASSWORD);
    return (
      await prisma.systemUser.create({
        data: {
          email,
          firstName: over.first ?? 'E2E',
          lastName: over.last ?? over.role ?? SystemRole.ADMIN,
          role: over.role ?? SystemRole.ADMIN,
          passwordHash,
          mustChangePassword: false,
          createdById: over.createdById ?? null,
          createdAt: over.createdAt,
          deletedAt: over.deletedAt ?? null,
          departmentId: over.departmentId ?? options.departmentId,
          personnelRoleId: over.personnelRoleId ?? options.personnelRoleId,
        },
        select: { id: true },
      })
    ).id;
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
    await purgeRows();

    // ── the windows must hold NO real event of any source ───────────────────────────────────────
    const S = dayStart('2021-03-01');
    const E = dayStart('2021-08-04');
    const [req, slot, acct, ann] = await Promise.all([
      prisma.bookingRequest.count({
        where: {
          OR: [
            { approvedAt: { gte: S, lt: E } },
            { createdAt: { gte: S, lt: E } },
            { updatedAt: { gte: S, lt: E } },
          ],
        },
      }),
      prisma.bookingSlot.count({ where: { cancelledAt: { gte: S, lt: E } } }),
      prisma.systemUser.count({ where: { createdAt: { gte: S, lt: E } } }),
      prisma.announcement.count({ where: { sentAt: { gte: S, lt: E } } }),
    ]);
    if (req + slot + acct + ann > 0) {
      throw new Error(
        `reports-activity.e2e-spec: 2021-03-01..2021-08-03 is NOT empty (requests=${req}, slots=${slot}, staff=${acct}, announcements=${ann}); refusing to seed on top of real data.`,
      );
    }

    const typeId = (
      await prisma.venueType.create({
        data: { name: `${PREFIX}hall` },
        select: { id: true },
      })
    ).id;
    venueId = (
      await prisma.venue.create({
        data: { name: `${PREFIX}open`, venueTypeId: typeId, capacity: 50 },
        select: { id: true },
      })
    ).id;
    deptId = (
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
    const reservedRoleId = (
      await prisma.personnelRole.create({
        data: { name: `${PREFIX}role-reserved`, isSystemReserved: true },
        select: { id: true },
      })
    ).id;
    liffId = (
      await prisma.lineUser.create({
        data: { lineUserId: `${PREFIX}Uliff0000000000000000000000000` },
        select: { id: true },
      })
    ).id;

    saId = await staff(SUPER, {
      role: SystemRole.SUPER_ADMIN,
      createdAt: bkk(2021, 1, 2),
    });
    adminId = await staff(ADMIN, {
      role: SystemRole.ADMIN,
      createdAt: bkk(2021, 1, 2),
    });
    await staff(VIEWER, {
      role: SystemRole.VIEWER,
      createdAt: bkk(2021, 1, 2),
    });
    softDeletedId = await staff(`${PREFIX}gone@easybook.local`, {
      first: 'ลบแล้ว',
      last: 'ทดสอบ',
      createdAt: bkk(2021, 1, 2),
      deletedAt: new Date(),
    });
    reservedStaffId = await staff(`${PREFIX}reserved@easybook.local`, {
      role: SystemRole.SUPER_ADMIN,
      first: 'ลับ',
      last: 'สงวน',
      createdAt: bkk(2021, 1, 2),
      departmentId: deptReservedId,
      personnelRoleId: reservedRoleId,
    });
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER])
      sessions[email] = await login(email);

    // ── MAIN (AC-A3): one of each provable type + three events that must NOT appear ─────────────
    await mk({
      key: 'apv',
      approvedAt: bkk(2021, 3, 10, 9, 15, 42),
      approvedById: adminId,
      slots: [{ startAt: bkk(2022, 1, 3, 9), endAt: bkk(2022, 1, 3, 10) }],
    });
    await mk({
      key: 'dir',
      createdById: saId,
      createdAt: bkk(2021, 3, 11, 10),
      approvedAt: bkk(2021, 3, 11, 10),
      approvedById: saId,
      slots: [{ startAt: bkk(2022, 1, 4, 9), endAt: bkk(2022, 1, 4, 10) }],
    });
    await mk({
      key: 'can',
      status: BookingStatus.CANCELLED,
      approvedAt: bkk(2021, 1, 5, 9),
      slots: [
        {
          startAt: bkk(2022, 1, 5, 9),
          endAt: bkk(2022, 1, 5, 10),
          isCancelled: true,
          cancelledAt: bkk(2021, 3, 12, 14),
          cancelledById: adminId,
          cancelledByRole: 'ADMIN',
          cancelReason: 'ห้องซ่อม',
        },
        {
          startAt: bkk(2022, 1, 12, 9),
          endAt: bkk(2022, 1, 12, 10),
          isCancelled: true,
          cancelledAt: bkk(2021, 3, 12, 14),
          cancelledById: adminId,
          cancelledByRole: 'ADMIN',
          cancelReason: 'ห้องซ่อม',
        },
      ],
    });
    await mk({
      key: 'rej',
      status: BookingStatus.REJECTED,
      rejectReason: 'ไม่เหมาะสมกับสถานที่',
      updatedAt: bkk(2021, 3, 13, 16, 5),
    });
    createdStaffId = await staff(`${PREFIX}new@easybook.local`, {
      first: '=EVIL',
      last: 'Staff',
      createdById: saId,
      createdAt: bkk(2021, 3, 5, 11),
    });
    await prisma.announcement.create({
      data: {
        title: `${PREFIX}announce`,
        body: 'x',
        status: 'SENT',
        audience: 'ALL',
        sentAt: bkk(2021, 3, 20, 8),
        sentCount: 1234,
        createdById: saId,
      },
    });
    // The three that are NOT staff actions (D-15):
    await mk({
      key: 'auto',
      status: BookingStatus.REJECTED,
      rejectReason: AUTO_REJECTED_REASON,
      updatedAt: bkk(2021, 3, 14, 9),
    });
    await mk({
      key: 'exp',
      status: BookingStatus.EXPIRED,
      rejectReason: AUTO_EXPIRED_REASON,
      updatedAt: bkk(2021, 3, 15, 9),
    });
    await mk({
      key: 'self',
      status: BookingStatus.CANCELLED,
      approvedAt: bkk(2021, 1, 6, 9),
      slots: [
        {
          startAt: bkk(2022, 1, 6, 9),
          endAt: bkk(2022, 1, 6, 10),
          isCancelled: true,
          cancelledAt: bkk(2021, 3, 16, 9),
          cancelledById: 'liff-user',
          cancelledByRole: 'LINE_USER',
        },
      ],
    });
    // A draft announcement is not a send.
    await prisma.announcement.create({
      data: {
        title: `${PREFIX}draft`,
        body: 'x',
        status: 'DRAFT',
        audience: 'ALL',
        createdById: saId,
        createdAt: bkk(2021, 1, 5),
      },
    });

    // ── TIES (AC-A7): 25 approvals at one identical instant ─────────────────────────────────────
    for (let i = 0; i < 25; i += 1) {
      await mk({
        key: `tie${i}`,
        approvedAt: bkk(2021, 5, 10, 12, 0, 0),
        approvedById: adminId,
      });
    }

    // ── EDGE (AC-A3 boundary) ───────────────────────────────────────────────────────────────────
    await mk({
      key: 'last',
      approvedAt: bkk(2021, 6, 30, 23, 59, 59),
      approvedById: adminId,
    });
    await mk({
      key: 'next',
      approvedAt: bkk(2021, 7, 1, 0, 0, 0),
      approvedById: adminId,
    });

    // ── STATES (AC-A10): actor renderings and the reserved fold ─────────────────────────────────
    await mk({
      key: 'stRes',
      approvedAt: bkk(2021, 8, 2, 9),
      approvedById: reservedStaffId,
    });
    await mk({
      key: 'stSoft',
      approvedAt: bkk(2021, 8, 2, 10),
      approvedById: softDeletedId,
    });
    await mk({
      key: 'stNull',
      approvedAt: bkk(2021, 8, 2, 11),
      approvedById: null,
    });
    await mk({
      key: 'stRej',
      status: BookingStatus.REJECTED,
      rejectReason: 'x',
      updatedAt: bkk(2021, 8, 2, 12),
    });
    await mk({
      key: 'stGhost',
      status: BookingStatus.CANCELLED,
      approvedAt: bkk(2021, 1, 7, 9),
      slots: [
        {
          startAt: bkk(2022, 1, 7, 9),
          endAt: bkk(2022, 1, 7, 10),
          isCancelled: true,
          cancelledAt: bkk(2021, 8, 2, 13),
          cancelledById: 'ghost-staff-id',
          cancelledByRole: 'SUPER_ADMIN',
        },
      ],
    });
    await mk({
      key: 'stPct',
      code: `${PREFIX}pct%-0001`,
      approvedAt: bkk(2021, 8, 2, 14),
      approvedById: adminId,
    });
    await mk({
      key: 'stResDept',
      departmentId: deptReservedId,
      approvedAt: bkk(2021, 8, 2, 15),
      approvedById: adminId,
    });
  });

  afterAll(async () => {
    await purgeRows();
    await app.close();
  });

  // ── AC-A1: role matrix ────────────────────────────────────────────────────────────────────────────
  describe('AC-A1 role matrix', () => {
    const paths = () => [
      `/reports/activity?${MAIN}`,
      `/reports/activity/kpis?${MAIN}`,
      `/reports/activity/actors?${MAIN}`,
      `/reports/activity/csv?${MAIN}`,
    ];

    it.each([0, 1, 2, 3])(
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
        (p: string) => p.replace(/^\/reports\/activity/, '/REPORTS/ACTIVITY'),
      ],
    ])(
      '%s answers like the canonical path and never skips @Roles',
      async (_l, mutate) => {
        for (const base of paths()) {
          const p = url(mutate(base));
          expect((await request(server()).get(p)).status).toBe(401);
          expect((await as(VIEWER).agent.get(p)).status).toBe(403);
          expect((await as(ADMIN).agent.get(p)).status).toBe(200);
        }
      },
    );

    it('a doubled or encoded slash matches no route: 404 for every role, never data', async () => {
      for (const v of [
        `/reports/activity//?${MAIN}`,
        `/reports//activity?${MAIN}`,
        `/reports/activity%2Fkpis?${MAIN}`,
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
          expect(res.body).not.toHaveProperty('items');
          expect(res.body).not.toHaveProperty('kpis');
        }
      }
    });

    it('rejects unknown keys, a bad limit and bad ranges with stable codes', async () => {
      const a = as(ADMIN).agent;
      expect(
        (await a.get(url(`/reports/activity?${MAIN}&bogus=1`))).status,
      ).toBe(400);
      expect(
        (await a.get(url(`/reports/activity?${MAIN}&limit=7`))).status,
      ).toBe(400);
      expect(
        (await a.get(url(`/reports/activity?${MAIN}&action=NOPE`))).status,
      ).toBe(400);
      expect(
        (await a.get(url(`/reports/activity/kpis?${MAIN}&action=APPROVE`)))
          .status,
      ).toBe(400); // KPIs take the range only
      expect(
        (await a.get(url(`/reports/activity/actors?${MAIN}&q=x`))).status,
      ).toBe(400);
      expect(
        (
          await a.get(
            url('/reports/activity?startDate=2021-03-02&endDate=2021-03-01'),
          )
        ).body,
      ).toMatchObject({ code: 'REPORT_RANGE_INVERTED' });
      expect(
        (
          await a.get(
            url(
              '/reports/activity/kpis?startDate=2019-01-01&endDate=2021-03-01',
            ),
          )
        ).body,
      ).toMatchObject({ code: 'REPORT_RANGE_TOO_WIDE' });
      expect(
        (
          await a.get(
            url('/reports/activity/csv?startDate=bad&endDate=2021-03-01'),
          )
        ).body,
      ).toMatchObject({ code: 'REPORT_DATE_INVALID' });
    });
  });

  // ── AC-A3 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-A3 event population', () => {
    it('lists every staff event exactly once with the right type, actor, time and target, and none of the system events', async () => {
      const res = await page(ADMIN, MAIN, '&limit=50');
      expect(res.total).toBe(6);
      const byAction = new Map(res.items.map((e) => [e.action, e]));
      expect([...byAction.keys()].sort()).toEqual([
        'ACCOUNT',
        'APPROVE',
        'BROADCAST',
        'CANCEL',
        'DIRECT_BOOKING',
        'REJECT',
      ]);

      const apv = byAction.get('APPROVE') as Event;
      expect(apv.id).toBe(`APV-${codes.apv}`);
      expect(apv.at).toBe(bkk(2021, 3, 10, 9, 15, 42).toISOString());
      expect(apv.actor).toMatchObject({
        id: adminId,
        role: 'ADMIN',
        state: 'ACTIVE',
      });
      expect(apv.target).toMatchObject({
        kind: 'BOOKING_REQUEST',
        label: codes.apv,
      });
      expect(apv.changes).toEqual([
        { field: 'สถานะคำขอ', before: 'รอพิจารณา', after: 'อนุมัติแล้ว' },
      ]);
      expect(apv.ip).toBeNull();
      expect(apv.userAgent).toBeNull();

      const dir = byAction.get('DIRECT_BOOKING') as Event;
      expect(dir.id).toBe(`DIR-${codes.dir}`);
      expect(dir.actor?.id).toBe(saId);

      const can = byAction.get('CANCEL') as Event;
      expect(can.id).toBe(
        `CAN-${codes.can}-${bkk(2021, 3, 12, 14).getTime().toString(36)}`,
      );
      expect(can.actor).toMatchObject({ id: adminId, role: 'ADMIN' });
      expect(can.summary).toContain('จำนวน 2 ช่วงเวลา');
      expect(can.changes?.[1]).toEqual({
        field: 'ช่วงเวลาที่ยกเลิก',
        before: '-',
        after: '2 ช่วงเวลา',
      });
      expect(can.note).toBe('ห้องซ่อม');

      const rej = byAction.get('REJECT') as Event;
      expect(rej.id).toBe(`REJ-${codes.rej}`);
      expect(rej.actor).toBeNull();
      expect(rej.atIsApproximate).toBe(true);
      expect(rej.at).toBe(bkk(2021, 3, 13, 16, 5).toISOString());
      expect(rej.note).toBe('ไม่เหมาะสมกับสถานที่');

      const acc = byAction.get('ACCOUNT') as Event;
      expect(acc.id).toBe(`ACC-${createdStaffId}`);
      expect(acc.actor?.id).toBe(saId);
      expect(acc.changes).toBeNull();
      expect(acc.target).toMatchObject({
        kind: 'STAFF_ACCOUNT',
        label: '=EVIL Staff',
      });

      const ann = byAction.get('BROADCAST') as Event;
      expect(ann.actor).toBeNull();
      expect(ann.summary).toBe('ส่งประกาศถึงผู้ใช้ 1,234 คน');
      expect(ann.target).toMatchObject({
        kind: 'ANNOUNCEMENT',
        label: `${PREFIX}announce`,
        detail: 'ผู้รับ ทุกคน',
      });

      const ids = res.items.map((e) => e.id).join('|');
      for (const key of ['auto', 'exp', 'self'])
        expect(ids).not.toContain(codes[key]);
      expect(ids).not.toContain('draft');
    });

    it('is newest first', async () => {
      const res = await page(SUPER, MAIN, '&limit=50');
      const ats = res.items.map((e) => e.at);
      expect(ats).toEqual([...ats].sort().reverse());
    });

    it('reports its capabilities honestly: synthesized, no IP, no venue changes, six actions', async () => {
      const res = await page(ADMIN, MAIN);
      expect(res.capabilities).toEqual({
        source: 'SYNTHESIZED',
        actions: [
          'APPROVE',
          'REJECT',
          'CANCEL',
          'DIRECT_BOOKING',
          'ACCOUNT',
          'BROADCAST',
        ],
        recordsIp: false,
        recordsResourceChanges: false,
      });
      expect(res.range).toEqual({
        startDate: '2021-03-01',
        endDate: '2021-03-30',
        days: 30,
      });
    });

    it('an event at 23:59:59 Bangkok on the last day is in; one at 00:00:00 the next day is out of that window and in its own', async () => {
      const last = await page(ADMIN, EDGE_LAST);
      expect(last.items.map((e) => e.id)).toEqual([`APV-${codes.last}`]);
      const next = await page(ADMIN, EDGE_NEXT);
      expect(next.items.map((e) => e.id)).toEqual([`APV-${codes.next}`]);
    });

    it("filters by the event's own time, not the booking use date", async () => {
      // The use dates are all in 2022; none of these events appears in a 2022 window.
      const res = await page(ADMIN, 'startDate=2022-01-01&endDate=2022-01-31');
      expect(res.total).toBe(0);
    });
  });

  // ── AC-A4 / AC-A5 ─────────────────────────────────────────────────────────────────────────────────
  describe('AC-A4 KPIs and actor options (range only)', () => {
    it('counts the decision types, leaves resource changes null and picks the top actor', async () => {
      const { kpis: k } = await kpis(ADMIN, MAIN);
      expect(k).toMatchObject({
        total: 6,
        days: 30,
        approve: 1,
        reject: 1,
        cancel: 1,
        directBooking: 1,
        resourceChanges: null,
      });
      // ADMIN and SUPER_ADMIN have 2 events each: the tie goes to the earlier name in Thai collation.
      expect(k.topActor?.actor.id).toBe(adminId);
      expect(k.topActor?.count).toBe(2);
      expect(k.topActor?.percent).toBeCloseTo((2 / 6) * 100, 8);
    });

    it('lists staff with at least one named event, Thai-sorted', async () => {
      const res = (
        await as(ADMIN)
          .agent.get(url(`/reports/activity/actors?${MAIN}`))
          .expect(200)
      ).body as {
        actors: Array<{ id: string; name: string; isDeleted: boolean }>;
      };
      expect(res.actors.map((a) => a.id).sort()).toEqual(
        [adminId, saId].sort(),
      );
      const names = res.actors.map((a) => a.name);
      expect(names).toEqual(
        [...names].sort((a, b) => a.localeCompare(b, 'th')),
      );
    });

    it("the KPIs do not move with the list's toolbar (they are a separate, range-only route)", async () => {
      const before = await kpis(ADMIN, MAIN);
      await page(ADMIN, MAIN, '&action=APPROVE&q=zzz&actorId=nobody');
      expect((await kpis(ADMIN, MAIN)).kpis).toEqual(before.kpis);
    });

    it('a range with no event has a null top actor', async () => {
      const { kpis: k } = await kpis(
        ADMIN,
        'startDate=2021-04-01&endDate=2021-04-02',
      );
      expect(k).toMatchObject({ total: 0, topActor: null });
    });
  });

  describe('AC-A5 toolbar', () => {
    it('filters by action and by actor; an unknown actor is an empty result, never a 400', async () => {
      expect((await page(ADMIN, MAIN, '&action=REJECT')).total).toBe(1);
      expect((await page(ADMIN, MAIN, `&actorId=${saId}`)).total).toBe(2);
      const none = await as(ADMIN).agent.get(
        url(`/reports/activity?${MAIN}&actorId=nobody-at-all`),
      );
      expect(none.status).toBe(200);
      expect((none.body as { total: number }).total).toBe(0);
    });

    it('searches code, actor, summary and note; % and _ are literal', async () => {
      expect(
        (await page(ADMIN, MAIN, `&q=${codes.apv.toLowerCase()}`)).total,
      ).toBe(1);
      expect((await page(ADMIN, MAIN, '&q=ห้องซ่อม')).total).toBe(1);
      expect((await page(ADMIN, MAIN, '&q=ปฏิเสธคำขอจอง')).total).toBe(1); // the Thai action label
      expect((await page(ADMIN, MAIN, '&q=1,234')).total).toBe(1);
      const pct = await page(ADMIN, STATES, '&q=%25');
      expect(pct.items.map((e) => e.target.label)).toEqual([
        `${PREFIX}pct%-0001`,
      ]);
      expect((await page(ADMIN, STATES, '&q=_')).total).toBe(0);
    });
  });

  // ── AC-A7 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-A7 pagination', () => {
    it('pages 25 events of one identical instant with no duplicate and no gap, in a stable order', async () => {
      const seen: string[] = [];
      for (const [p, size] of [
        [1, 10],
        [2, 10],
        [3, 5],
      ] as const) {
        const res = await page(ADMIN, TIES, `&limit=10&page=${p}`);
        expect(res.total).toBe(25);
        expect(res.totalPages).toBe(3);
        expect(res.page).toBe(p);
        expect(res.items).toHaveLength(size);
        seen.push(...res.items.map((e) => e.id));
      }
      expect(new Set(seen).size).toBe(25);
      expect(seen).toEqual([...seen].sort().reverse()); // ties break by id, descending
      const again = await page(ADMIN, TIES, '&limit=10&page=2');
      expect(again.items.map((e) => e.id)).toEqual(seen.slice(10, 20));
    });

    it('clamps a page past the end and defaults to 10 per page', async () => {
      const clamped = await page(ADMIN, TIES, '&limit=10&page=99');
      expect(clamped.page).toBe(3);
      expect(clamped.items).toHaveLength(5);
      const def = await page(ADMIN, TIES);
      expect(def.limit).toBe(10);
      expect(def.items).toHaveLength(10);
      expect((await page(ADMIN, TIES, '&limit=50')).items).toHaveLength(25);
    });
  });

  // ── AC-A10 ────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-A10 privacy and actor states', () => {
    it('renders each actor state as the contract says', async () => {
      const res = await page(SUPER, STATES, '&limit=50');
      const by = (key: string) =>
        res.items.find((e) => e.target.label === codes[key]) as Event;
      expect(by('stSoft').actor).toMatchObject({
        id: softDeletedId,
        name: 'ลบแล้ว ทดสอบ',
        state: 'SOFT_DELETED',
      });
      expect(by('stNull').actor).toEqual({
        id: null,
        name: null,
        role: null,
        position: null,
        department: null,
        state: 'HARD_DELETED',
      });
      expect(by('stRej').actor).toBeNull();
      expect(by('stGhost').actor).toEqual({
        id: 'ghost-staff-id',
        name: null,
        role: 'SUPER_ADMIN',
        position: null,
        department: null,
        state: 'HARD_DELETED',
      });
      expect(by('stRes').actor).toMatchObject({
        id: reservedStaffId,
        state: 'ACTIVE',
      });
    });

    it('folds the reserved department and title for ADMIN, shows them to SUPER_ADMIN', async () => {
      const forAdmin = await page(ADMIN, STATES, '&limit=50');
      const reservedAdmin = forAdmin.items.find(
        (e) => e.target.label === codes.stRes,
      ) as Event;
      expect(reservedAdmin.actor?.department).toBeNull();
      expect(reservedAdmin.actor?.position).toBeNull();
      const target = forAdmin.items.find(
        (e) => e.target.label === codes.stResDept,
      ) as Event;
      expect(target.target.detail).toBe(`${PREFIX}open · ไม่ระบุกลุ่ม/ฝ่าย`);
      expect(JSON.stringify(forAdmin)).not.toContain(`${PREFIX}dept-reserved`);
      expect(JSON.stringify(forAdmin)).not.toContain(`${PREFIX}role-reserved`);

      const forSuper = await page(SUPER, STATES, '&limit=50');
      const reservedSuper = forSuper.items.find(
        (e) => e.target.label === codes.stRes,
      ) as Event;
      expect(reservedSuper.actor).toMatchObject({
        department: `${PREFIX}dept-reserved`,
        position: `${PREFIX}role-reserved`,
      });
      expect(
        forSuper.items.find((e) => e.target.label === codes.stResDept)?.target
          .detail,
      ).toBe(`${PREFIX}open · ${PREFIX}dept-reserved`);
    });

    it.each([ADMIN, SUPER])(
      '%s: no LINE id, phone, e-mail, hash or token in any response (raw regex)',
      async (email) => {
        const bodies = [
          JSON.stringify(await page(email, MAIN, '&limit=50')),
          JSON.stringify(await page(email, STATES, '&limit=50')),
          JSON.stringify(await kpis(email, MAIN)),
          JSON.stringify(
            (
              await as(email)
                .agent.get(url(`/reports/activity/actors?${MAIN}`))
                .expect(200)
            ).body,
          ),
          (
            await as(email)
              .agent.get(url(`/reports/activity/csv?${MAIN}`))
              .expect(200)
          ).text,
        ];
        for (const raw of bodies) {
          expect(raw).not.toMatch(/U[0-9a-f]{32}/);
          expect(raw).not.toMatch(/\b0\d{2}-?\d{3}-?\d{4}\b/);
          expect(raw).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
          expect(raw).not.toMatch(
            /\$argon2|passwordHash|csrf|eb\.sid|session/i,
          );
          expect(raw).not.toContain(`${PREFIX}U`);
        }
      },
    );
  });

  // ── AC-A9 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-A9 CSV', () => {
    const csvOf = async (email: string, q: string) =>
      as(email)
        .agent.get(url(`/reports/activity/csv?${q}`))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            cb(
              null,
              Buffer.concat(chunks).toString('utf8') as unknown as Buffer,
            ),
          );
        })
        .expect(200);

    it('holds EVERY row (not the page), with the title, range and the header minus IP columns', async () => {
      const res = await csvOf(ADMIN, MAIN);
      const body = res.body as unknown as string;
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="easybook-audit_2021-03-01_2021-03-30.csv"',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body.charCodeAt(0)).toBe(0xfeff);
      const lines = body.slice(1).split('\r\n');
      expect(lines.pop()).toBe(''); // trailing CRLF
      expect(lines[0]).toBe('ประวัติการทำรายการ');
      expect(lines[1]).toBe('ช่วงข้อมูล 1 มี.ค. 2564 ถึง 30 มี.ค. 2564');
      expect(lines[2]).toBe('');
      expect(lines[3]).toBe(
        'รหัสเหตุการณ์,วันที่,เวลา,เจ้าหน้าที่ผู้กระทำ,บทบาท,กลุ่ม/ฝ่าย,การกระทำ,ประเภทเป้าหมาย,เป้าหมาย,รายละเอียดเป้าหมาย,สรุปการเปลี่ยนแปลง,หมายเหตุ',
      );
      expect(lines.slice(4)).toHaveLength(6);
      expect(body).not.toContain('IP Address');
    });

    it('the ties window is all 25 rows even though the list pages at 10', async () => {
      const body = (await csvOf(ADMIN, TIES)).body as unknown as string;
      expect(
        body
          .slice(1)
          .split('\r\n')
          .filter((l) => l.startsWith('APV-')),
      ).toHaveLength(25);
    });

    it('marks a filtered export and neutralises a formula-looking cell', async () => {
      const filtered = (await csvOf(ADMIN, `${MAIN}&action=ACCOUNT`))
        .body as unknown as string;
      expect(filtered).toContain('(กรองแล้ว)');
      expect(filtered).toContain("'=EVIL Staff");
      expect(filtered).not.toContain(',=EVIL');
      const plain = (await csvOf(ADMIN, MAIN)).body as unknown as string;
      expect(plain).not.toContain('(กรองแล้ว)');
    });

    it('renders the actor states and roles in Thai, with an empty cell for no actor role', async () => {
      const body = (await csvOf(SUPER, `${STATES}`)).body as unknown as string;
      expect(body).toContain('ลบแล้ว ทดสอบ (ลบแล้ว)');
      expect(body).toContain('ไม่ทราบผู้กระทำ (บัญชีถูกลบ)');
      expect(body).toContain('ไม่ได้บันทึกผู้กระทำ');
      expect(body).toContain('ผู้ดูแลระบบสูงสุด');
    });
  });
});
