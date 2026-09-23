import type { INestApplication } from '@nestjs/common';
import {
  AppAccess,
  FeedbackStatus,
  FeedbackType,
  SystemRole,
} from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import {
  FEEDBACK_NO_CHANGE,
  FEEDBACK_NOT_FOUND,
  FEEDBACK_UPDATE_EMPTY,
} from '../src/feedback/feedback.constants';
import { INVALID_CSRF_TOKEN } from '../src/csrf/csrf.service';
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

/**
 * `ADMIN-FEEDBACK-1` — the admin triage console (`/feedback`), design §6 E-1…E-14.
 *
 * ⚠️ THIS RUNS AGAINST A SHARED DATABASE that may hold real reports, so no assertion assumes the
 * table is empty: list assertions are narrowed by this file's own venue, a unique search token, or
 * the fixture code prefix, and `counts` is checked against a direct `groupBy` taken at the same time.
 *
 * `test/feedback.e2e-spec.ts` (the LIFF half) is deliberately NOT touched (AC-23).
 */

const SU_PREFIX = 'e2e-afbsu-';
const LU_PREFIX = 'e2eafb-';
const ROW_PREFIX = 'e2e-afb-';
const CODE_PREFIX = 'E2EAFB-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;
const DOOMED = `${SU_PREFIX}doomed@easybook.local`;

/** A search token no real report contains, carried by every "searchable" fixture's subject. */
const TOKEN = 'zqafbtoken';
const LAST_NAME = 'Zqafblastname';
const NO_REG_DISPLAY = 'ZqafbNoRegDisplay';
const DESC_ONLY_WORD = 'zqafbdescriptiononly';
const REG_SUB = `${LU_PREFIX}Ureg`;
const NO_REG_SUB = `${LU_PREFIX}Unoreg`;

/** Fixed, long-past instants: far from "today", so the LIFF code minter's per-day count never sees them. */
const T0 = Date.UTC(2026, 0, 5, 3, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface Reporter {
  firstName: string | null;
  lastName: string | null;
  personnelRoleName: string | null;
  departmentName: string | null;
  phone: string | null;
  lineDisplayName: string | null;
  pictureUrl: string | null;
}

interface ListItem {
  id: string;
  code: string;
  type: FeedbackType;
  status: FeedbackStatus;
  subject: string;
  description: string;
  photoCount: number;
  venue: { id: string; name: string } | null;
  reporter: Reporter;
  createdAt: string;
}

interface LogBody {
  id: string;
  status: FeedbackStatus;
  note: string | null;
  createdAt: string;
  author: { id: string; firstName: string; lastName: string } | null;
}

interface Detail extends ListItem {
  photos: string[];
  logs: LogBody[];
}

interface Counts {
  pendingCount: number;
  issueCount: number;
  feedbackCount: number;
}

interface ListBody {
  data: ListItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  counts: Counts;
}

describe('Admin feedback console (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  let venueId = '';
  let goneVenueId = '';
  let regLineUserId = '';
  let noRegLineUserId = '';
  let staffIds: Record<string, string> = {};
  let sessions: Record<string, Session> = {};
  let codeSeq = 0;

  /** The four listed fixtures (F-tie rows are separate). */
  const f: Record<'issue' | 'general' | 'gone', { id: string; code: string }> =
    {
      issue: { id: '', code: '' },
      general: { id: '', code: '' },
      gone: { id: '', code: '' },
    };

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

  const as = (email: string) => sessions[email];

  const list = async (email: string, qs: string): Promise<ListBody> =>
    (
      await as(email)
        .agent.get(url(`/feedback${qs}`))
        .expect(200)
    ).body as ListBody;

  const detail = async (email: string, id: string): Promise<Detail> =>
    (
      await as(email)
        .agent.get(url(`/feedback/${id}`))
        .expect(200)
    ).body as Detail;

  const patch = (email: string, id: string, body: unknown) =>
    as(email)
      .agent.patch(url(`/feedback/${id}`))
      .set('x-csrf-token', as(email).token)
      .send(body as object);

  /** Raw SQL — the application never hard-deletes, and fixtures must not accumulate. */
  const purgeRows = async () => {
    // `feedback_logs` go with their report (Cascade); reports go with their reporter (Cascade).
    await prisma.$executeRawUnsafe(
      `DELETE FROM feedbacks WHERE code LIKE '${CODE_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM line_users WHERE "lineUserId" LIKE '${LU_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venues WHERE name LIKE '${ROW_PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM venue_types WHERE name LIKE '${ROW_PREFIX}%'`,
    );
  };

  const seedFeedback = async (opts: {
    type?: FeedbackType;
    status?: FeedbackStatus;
    venue?: string | null;
    lineUser?: string;
    subject?: string;
    description?: string;
    photos?: string[];
    createdAt?: Date;
  }): Promise<{ id: string; code: string }> =>
    prisma.feedback.create({
      data: {
        code: `${CODE_PREFIX}${String(++codeSeq).padStart(4, '0')}`,
        type: opts.type ?? FeedbackType.ISSUE,
        status: opts.status ?? FeedbackStatus.PENDING,
        lineUserId: opts.lineUser ?? regLineUserId,
        venueId: opts.venue === undefined ? venueId : opts.venue,
        subject: opts.subject ?? 'ไม่มีคำค้น',
        description: opts.description ?? 'รายละเอียดทั่วไป',
        photos: opts.photos ?? [],
        createdAt: opts.createdAt ?? at(0),
      },
      select: { id: true, code: true },
    });

  /** What a refused write must leave untouched. */
  const snapshot = async (id: string) => {
    const row = await prisma.feedback.findUnique({
      where: { id },
      select: { status: true, updatedAt: true },
    });
    const logs = await prisma.feedbackLog.count({ where: { feedbackId: id } });
    return { status: row?.status, updatedAt: row?.updatedAt, logs };
  };

  const globalCounts = async (): Promise<Counts> => {
    const grouped = await prisma.feedback.groupBy({
      by: ['type', 'status'],
      _count: { _all: true },
    });
    const sum = (match: (g: (typeof grouped)[number]) => boolean) =>
      grouped.filter(match).reduce((n, g) => n + g._count._all, 0);
    return {
      pendingCount: sum((g) => g.status === FeedbackStatus.PENDING),
      issueCount: sum((g) => g.type === FeedbackType.ISSUE),
      feedbackCount: sum((g) => g.type === FeedbackType.FEEDBACK),
    };
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);

    await purgeRows();
    await purgeE2eUsers(prisma, SU_PREFIX);

    const typeId = (
      await prisma.venueType.create({
        data: { name: `${ROW_PREFIX}hall` },
        select: { id: true },
      })
    ).id;
    venueId = (
      await prisma.venue.create({
        data: { name: `${ROW_PREFIX}room`, venueTypeId: typeId, capacity: 30 },
        select: { id: true },
      })
    ).id;
    goneVenueId = (
      await prisma.venue.create({
        data: {
          name: `${ROW_PREFIX}gone`,
          venueTypeId: typeId,
          capacity: 10,
          deletedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

    const options = await ensureE2eOptions(prisma);
    regLineUserId = (
      await prisma.lineUser.create({
        data: {
          lineUserId: REG_SUB,
          access: AppAccess.ALLOWED,
          displayName: 'ZqafbRegDisplay',
          pictureUrl: 'https://profile.line-scdn.net/zqafb-reg',
        },
        select: { id: true },
      })
    ).id;
    await prisma.lineUserRegistration.create({
      data: {
        lineUserId: regLineUserId,
        firstName: 'สมชาย',
        lastName: LAST_NAME,
        phone: '081-234-5678',
        phoneDigits: '0812345678',
        departmentId: options.departmentId,
        personnelRoleId: options.personnelRoleId,
      },
    });
    noRegLineUserId = (
      await prisma.lineUser.create({
        data: {
          lineUserId: NO_REG_SUB,
          access: AppAccess.ALLOWED,
          displayName: NO_REG_DISPLAY,
        },
        select: { id: true },
      })
    ).id;

    const passwordHash = await new PasswordService().hash(PASSWORD);
    const base = { passwordHash, mustChangePassword: false, ...options };
    staffIds = {};
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
      [DOOMED, SystemRole.ADMIN],
    ] as Array<[string, SystemRole]>) {
      const row = await prisma.systemUser.create({
        data: { email, firstName: 'E2E', lastName: role, role, ...base },
        select: { id: true },
      });
      staffIds[email] = row.id;
    }
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER]) {
      sessions[email] = await login(email);
    }

    // The listed fixtures. Newest first by construction: issue (+50) > general (+40) > gone (+30).
    f.issue = await seedFeedback({
      type: FeedbackType.ISSUE,
      subject: `${TOKEN} แอร์ห้องประชุมไม่เย็น`,
      description: `แอร์เสียมาสามวัน ${DESC_ONLY_WORD}`,
      photos: [
        'https://cdn.example.org/feedback/b.jpg',
        'https://cdn.example.org/feedback/a.jpg',
      ],
      createdAt: at(50),
    });
    f.general = await seedFeedback({
      type: FeedbackType.FEEDBACK,
      venue: null,
      lineUser: noRegLineUserId,
      subject: `${TOKEN} ขอเพิ่มปลั๊กไฟ`,
      createdAt: at(40),
    });
    f.gone = await seedFeedback({
      type: FeedbackType.ISSUE,
      status: FeedbackStatus.IN_PROGRESS,
      venue: goneVenueId,
      subject: `${TOKEN} โต๊ะชำรุด`,
      createdAt: at(30),
    });
  }, 120_000);

  afterAll(async () => {
    await purgeRows();
    await purgeE2eUsers(prisma, SU_PREFIX);
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-1 — GET list roles
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('GET /feedback — roles (AC-2)', () => {
    it.each([SUPER, ADMIN, VIEWER])('%s → 200', async (email) => {
      const body = await list(email, `?q=${TOKEN}`);
      expect(body.meta.total).toBe(3);
    });

    it('no session → 401', async () => {
      await request(server()).get(url('/feedback')).expect(401);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-2 — query validation
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('GET /feedback — query validation (AC-3)', () => {
    it.each([
      ['limit=25', '?limit=25'],
      ['page=0', '?page=0'],
      ['an unknown key', '?foo=1'],
      ['an unknown status', '?status=NOPE'],
      ['an unknown type', '?type=NOPE'],
      ['q over 100 characters', `?q=${'x'.repeat(101)}`],
    ])('%s → 400', async (_label, qs) => {
      await as(ADMIN)
        .agent.get(url(`/feedback${qs}`))
        .expect(400);
    });

    it('defaults to page 1, limit 10', async () => {
      const body = await list(ADMIN, `?q=${TOKEN}`);
      expect(body.meta).toEqual({
        page: 1,
        limit: 10,
        total: 3,
        totalPages: 1,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-3 — venue filter
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('GET /feedback — venueId (AC-5)', () => {
    it('venueId=general returns only reports with no venue', async () => {
      const body = await list(ADMIN, `?venueId=general&q=${TOKEN}`);
      expect(body.data.map((r) => r.id)).toEqual([f.general.id]);

      const wide = await list(ADMIN, '?venueId=general&limit=50');
      expect(wide.data.every((r) => r.venue === null)).toBe(true);
    });

    it('an exact venue id filters to it; a soft-deleted venue still resolves its name (E-3)', async () => {
      const body = await list(ADMIN, `?venueId=${goneVenueId}`);
      expect(body.data.map((r) => r.id)).toEqual([f.gone.id]);
      expect(body.data[0].venue).toEqual({
        id: goneVenueId,
        name: `${ROW_PREFIX}gone`,
      });
    });

    it('an unknown venue id → 200 with an empty page, not a 400', async () => {
      const body = await list(ADMIN, '?venueId=cnotarealvenue0000000000000');
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
      expect(body.meta.totalPages).toBe(0);
    });

    it('filters combine with AND', async () => {
      const body = await list(
        ADMIN,
        `?q=${TOKEN}&type=ISSUE&status=PENDING&venueId=${venueId}`,
      );
      expect(body.data.map((r) => r.id)).toEqual([f.issue.id]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-4 — global counts
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('GET /feedback — counts are GLOBAL (AC-8)', () => {
    it('the same counts with no filter and with type+status+q+venueId+page=99', async () => {
      const expected = await globalCounts();
      const plain = await list(ADMIN, '');
      const filtered = await list(
        ADMIN,
        `?type=ISSUE&status=PENDING&q=${TOKEN}&venueId=general&page=99`,
      );

      expect(plain.counts).toEqual(expected);
      expect(filtered.counts).toEqual(expected);
      expect(expected.issueCount).toBeGreaterThanOrEqual(2);
      expect(expected.feedbackCount).toBeGreaterThanOrEqual(1);
    });

    it('a page beyond the end → data: [] with a correct meta (AC-4)', async () => {
      const body = await list(ADMIN, `?q=${TOKEN}&page=99`);
      expect(body.data).toEqual([]);
      expect(body.meta).toEqual({
        page: 99,
        limit: 10,
        total: 3,
        totalPages: 1,
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-5 — search
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('GET /feedback — q (AC-6)', () => {
    it('matches the registration last name, case-insensitively', async () => {
      const body = await list(ADMIN, `?q=${LAST_NAME.toUpperCase()}`);
      expect(body.data.map((r) => r.id).sort()).toEqual(
        [f.issue.id, f.gone.id].sort(),
      );
    });

    it('matches the LINE display name (the name shown with no registration)', async () => {
      const body = await list(ADMIN, `?q=${NO_REG_DISPLAY.toLowerCase()}`);
      expect(body.data.map((r) => r.id)).toEqual([f.general.id]);
    });

    it('matches #code with the leading # stripped', async () => {
      const body = await list(
        ADMIN,
        `?q=${encodeURIComponent(`#${f.issue.code}`)}`,
      );
      expect(body.data.map((r) => r.id)).toEqual([f.issue.id]);
    });

    it('does NOT match a word found only in the description', async () => {
      const body = await list(ADMIN, `?q=${DESC_ONLY_WORD}`);
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-6 — order
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('GET /feedback — order (AC-7)', () => {
    it('newest first', async () => {
      const body = await list(ADMIN, `?q=${TOKEN}`);
      expect(body.data.map((r) => r.id)).toEqual([
        f.issue.id,
        f.general.id,
        f.gone.id,
      ]);
    });

    it('rows with an equal createdAt keep one stable order across pages — none repeated, none skipped', async () => {
      // A venue of its own, so the page is exactly these rows.
      const typeId = (
        await prisma.venueType.findFirstOrThrow({
          where: { name: `${ROW_PREFIX}hall` },
          select: { id: true },
        })
      ).id;
      const tieVenue = (
        await prisma.venue.create({
          data: {
            name: `${ROW_PREFIX}ties`,
            venueTypeId: typeId,
            capacity: 5,
          },
          select: { id: true },
        })
      ).id;
      const ties: { id: string; code: string }[] = [];
      for (let i = 0; i < 12; i++) {
        ties.push(await seedFeedback({ venue: tieVenue, createdAt: at(10) }));
      }

      const page1 = await list(ADMIN, `?venueId=${tieVenue}&limit=10`);
      const page2 = await list(ADMIN, `?venueId=${tieVenue}&limit=10&page=2`);
      const seen = [...page1.data, ...page2.data].map((r) => r.code);

      expect(page1.meta.total).toBe(12);
      expect(page2.data).toHaveLength(2);
      expect(new Set(seen).size).toBe(12);
      // The tie-breaker is `code` DESC.
      expect(seen).toEqual(
        ties
          .map((t) => t.code)
          .sort()
          .reverse(),
      );

      await prisma.feedback.deleteMany({ where: { venueId: tieVenue } });
      await prisma.venue.delete({ where: { id: tieVenue } });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-7 / E-8 — detail
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('GET /feedback/:id (AC-10…AC-13)', () => {
    it.each([SUPER, ADMIN, VIEWER])('%s → 200', async (email) => {
      const body = await detail(email, f.issue.id);
      expect(body.id).toBe(f.issue.id);
    });

    it('no session → 401', async () => {
      await request(server())
        .get(url(`/feedback/${f.issue.id}`))
        .expect(401);
    });

    it.each([
      ['an unknown cuid', 'cnotarealfeedback000000000'],
      ['a malformed id', 'not-a-cuid'],
    ])('%s → 404', async (_label, id) => {
      const res = await as(ADMIN)
        .agent.get(url(`/feedback/${id}`))
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        FEEDBACK_NOT_FOUND,
      );
    });

    it('an untouched report is PENDING with logs: [], photos in stored order, full reporter, and no LINE subject', async () => {
      const res = await as(ADMIN)
        .agent.get(url(`/feedback/${f.issue.id}`))
        .expect(200);
      const body = res.body as Detail;

      expect(body.status).toBe(FeedbackStatus.PENDING);
      expect(body.logs).toEqual([]);
      expect(body.photos).toEqual([
        'https://cdn.example.org/feedback/b.jpg',
        'https://cdn.example.org/feedback/a.jpg',
      ]);
      expect(body.photoCount).toBe(2);
      expect(body.venue).toEqual({ id: venueId, name: `${ROW_PREFIX}room` });
      expect(body.reporter).toEqual({
        firstName: 'สมชาย',
        lastName: LAST_NAME,
        personnelRoleName: 'E2E Fixture Option',
        departmentName: 'E2E Fixture Option',
        phone: '081-234-5678',
        lineDisplayName: 'ZqafbRegDisplay',
        pictureUrl: 'https://profile.line-scdn.net/zqafb-reg',
      });
      // 🔴 AC-13: the `U…` subject appears nowhere in the body.
      expect(JSON.stringify(res.body)).not.toContain(REG_SUB);
    });

    it('a missing registration → 200 with null reporter fields (E-8, AC-13)', async () => {
      const res = await as(ADMIN)
        .agent.get(url(`/feedback/${f.general.id}`))
        .expect(200);
      const body = res.body as Detail;

      expect(body.venue).toBeNull();
      expect(body.reporter).toEqual({
        firstName: null,
        lastName: null,
        personnelRoleName: null,
        departmentName: null,
        phone: null,
        lineDisplayName: NO_REG_DISPLAY,
        pictureUrl: null,
      });
      expect(JSON.stringify(res.body)).not.toContain(NO_REG_SUB);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-9…E-12 — PATCH
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('PATCH /feedback/:id (AC-14…AC-21)', () => {
    let target = { id: '', code: '' };

    beforeEach(async () => {
      target = await seedFeedback({ createdAt: at(1) });
    });

    it('E-9 ADMIN: a status change, then a note-only save → two logs ASC, the second keeping the status', async () => {
      const first = await patch(ADMIN, target.id, {
        status: FeedbackStatus.IN_PROGRESS,
      }).expect(200);
      const one = first.body as Detail;
      expect(one.status).toBe(FeedbackStatus.IN_PROGRESS);
      expect(one.logs).toHaveLength(1);
      expect(one.logs[0]).toMatchObject({
        status: FeedbackStatus.IN_PROGRESS,
        note: null,
        author: { id: staffIds[ADMIN], firstName: 'E2E', lastName: 'ADMIN' },
      });

      const second = await patch(ADMIN, target.id, {
        note: '  ประสานช่างแล้ว  ',
      }).expect(200);
      const two = second.body as Detail;
      expect(two.status).toBe(FeedbackStatus.IN_PROGRESS);
      expect(two.logs).toHaveLength(2);
      expect(two.logs[1]).toMatchObject({
        status: FeedbackStatus.IN_PROGRESS,
        note: 'ประสานช่างแล้ว',
      });
      // ASC (D-11): the first save is first.
      expect(two.logs[0].id).toBe(one.logs[0].id);
      expect(Date.parse(two.logs[0].createdAt)).toBeLessThanOrEqual(
        Date.parse(two.logs[1].createdAt),
      );

      // The GET agrees with the PATCH echo.
      expect((await detail(VIEWER, target.id)).logs).toEqual(two.logs);
    });

    it('a note-only save leaves the report row (and updatedAt) untouched (AC-18)', async () => {
      const before = await snapshot(target.id);
      await patch(ADMIN, target.id, { note: 'บันทึกอย่างเดียว' }).expect(200);
      const after = await snapshot(target.id);

      expect(after.status).toBe(FeedbackStatus.PENDING);
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.logs).toBe(1);
    });

    it('SUPER_ADMIN may save, and RESOLVED → PENDING re-opens a report (AC-21)', async () => {
      await patch(SUPER, target.id, {
        status: FeedbackStatus.RESOLVED,
        note: 'แก้ไขแล้ว',
      }).expect(200);
      const res = await patch(SUPER, target.id, {
        status: FeedbackStatus.PENDING,
      }).expect(200);
      const body = res.body as Detail;

      expect(body.status).toBe(FeedbackStatus.PENDING);
      expect(body.logs.map((l) => l.status)).toEqual([
        FeedbackStatus.RESOLVED,
        FeedbackStatus.PENDING,
      ]);
      expect(body.logs[1].author?.id).toBe(staffIds[SUPER]);
    });

    it('a 500-character note (after trimming) is accepted', async () => {
      await patch(ADMIN, target.id, { note: ` ${'ก'.repeat(500)} ` }).expect(
        200,
      );
    });

    it('E-10 VIEWER (with CSRF) → 403, row and log count unchanged', async () => {
      const before = await snapshot(target.id);
      await patch(VIEWER, target.id, {
        status: FeedbackStatus.RESOLVED,
      }).expect(403);
      expect(await snapshot(target.id)).toEqual(before);
    });

    it('E-11 ADMIN without x-csrf-token → 403, no write', async () => {
      const before = await snapshot(target.id);
      const res = await as(ADMIN)
        .agent.patch(url(`/feedback/${target.id}`))
        .send({ status: FeedbackStatus.RESOLVED })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        INVALID_CSRF_TOKEN,
      );
      expect(await snapshot(target.id)).toEqual(before);
    });

    it('E-11 ADMIN with a forged x-csrf-token → 403, no write', async () => {
      const before = await snapshot(target.id);
      await as(ADMIN)
        .agent.patch(url(`/feedback/${target.id}`))
        .set('x-csrf-token', 'forged-token')
        .send({ status: FeedbackStatus.RESOLVED })
        .expect(403);
      expect(await snapshot(target.id)).toEqual(before);
    });

    it('no session (but a valid CSRF pair) → 401', async () => {
      const agent = request.agent(server());
      const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
      await agent
        .patch(url(`/feedback/${target.id}`))
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .send({ status: FeedbackStatus.RESOLVED })
        .expect(401);
    });

    it.each([
      ['an empty body', {}, FEEDBACK_UPDATE_EMPTY],
      ['a whitespace-only note', { note: '   ' }, FEEDBACK_UPDATE_EMPTY],
      [
        'the current status with a blank note',
        { status: FeedbackStatus.PENDING, note: '  ' },
        FEEDBACK_NO_CHANGE,
      ],
    ])(
      'E-12 %s → 400 with its own single-string message, nothing written',
      async (_label, body, message) => {
        const before = await snapshot(target.id);
        const res = await patch(ADMIN, target.id, body).expect(400);
        expect((res.body as { message: unknown }).message).toBe(message);
        expect(await snapshot(target.id)).toEqual(before);
      },
    );

    it.each([
      ['status DISMISSED', { status: FeedbackStatus.DISMISSED }],
      ['status null', { status: null }],
      ['authorId in the body', { note: 'x', authorId: 'clx_forged' }],
      ['feedbackId in the body', { note: 'x', feedbackId: 'clx_other' }],
      ['a 501-character note', { note: 'ก'.repeat(501) }],
    ])('E-12 %s → 400, nothing written', async (_label, body) => {
      const before = await snapshot(target.id);
      await patch(ADMIN, target.id, body).expect(400);
      expect(await snapshot(target.id)).toEqual(before);
    });

    it('E-12 an unknown id → 404, nothing written', async () => {
      const logsBefore = await prisma.feedbackLog.count();
      const res = await patch(ADMIN, 'cnotarealfeedback000000000', {
        status: FeedbackStatus.RESOLVED,
      }).expect(404);
      expect((res.body as { message: string }).message).toBe(
        FEEDBACK_NOT_FOUND,
      );
      expect(await prisma.feedbackLog.count()).toBe(logsBefore);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // E-13 / E-14 — FK behaviour
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('FeedbackLog foreign keys', () => {
    it('E-13 a hard-deleted author → the log survives with author: null', async () => {
      const target = await seedFeedback({ createdAt: at(2) });
      const doomed = await login(DOOMED);
      await doomed.agent
        .patch(url(`/feedback/${target.id}`))
        .set('x-csrf-token', doomed.token)
        .send({ status: FeedbackStatus.IN_PROGRESS, note: 'ก่อนลาออก' })
        .expect(200);

      await prisma.$executeRawUnsafe(
        `DELETE FROM system_users WHERE id = '${staffIds[DOOMED]}'`,
      );

      const body = await detail(ADMIN, target.id);
      expect(body.logs).toHaveLength(1);
      expect(body.logs[0]).toMatchObject({
        status: FeedbackStatus.IN_PROGRESS,
        note: 'ก่อนลาออก',
        author: null,
      });
    });

    it('E-14 deleting a report cascades to its logs', async () => {
      const target = await seedFeedback({ createdAt: at(3) });
      await patch(ADMIN, target.id, { note: 'หนึ่ง' }).expect(200);
      await patch(ADMIN, target.id, { note: 'สอง' }).expect(200);
      expect(
        await prisma.feedbackLog.count({ where: { feedbackId: target.id } }),
      ).toBe(2);

      await prisma.feedback.delete({ where: { id: target.id } });

      expect(
        await prisma.feedbackLog.count({ where: { feedbackId: target.id } }),
      ).toBe(0);
    });
  });
});
