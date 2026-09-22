import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  AnnouncementAudience,
  AnnouncementFormat,
  AnnouncementStatus,
  SystemRole,
} from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ANNOUNCEMENT_DEPARTMENT_INVALID,
  ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
  ANNOUNCEMENT_DEPARTMENT_REQUIRED,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_SENT_IMMUTABLE,
  ANNOUNCEMENT_UPDATE_EMPTY,
} from '../src/announcements/announcements.constants';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
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
 * `ANNOUNCE-API-1` phase 1 — `/announcements` CRUD (plan AC-1…AC-12, design §7.2). `ANNOUNCE-API-5`
 * turns DELETE into a soft delete: its AC-1 (column + index), AC-2, AC-3, AC-5, AC-6 live here.
 *
 * 🔴 THIS RUNS AGAINST THE SHARED DEV DATABASE, which holds real working data:
 * - every announcement this file creates is tracked in `createdIds` and deleted BY ID in `afterAll`;
 *   the only other delete is a crash-recovery sweep of titles starting with this file's unique `ROOT`;
 * - every fixture title starts with `ROOT`, and list assertions are narrowed with `q` — nothing assumes
 *   the table is empty or asserts a global total;
 * - the departments used are this file's own (`e2e-ann-…`), deleted by id AFTER the announcements;
 *   real departments are never touched.
 */

const SU_PREFIX = 'e2e-annsu-';
const DEPT_PREFIX = 'e2e-ann-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;
const DOOMED = `${SU_PREFIX}doomed@easybook.local`;

/** Every fixture title starts with this. No real announcement contains it. */
const ROOT = 'zqanne2e';
/** Sub-tokens, each narrowing one group of fixtures. */
const LIST = `${ROOT}list`;
const LIT = `${ROOT}lit`;
const BODY_ONLY = 'zqannbodyonlyword';

/** Fixed, long-past instants, so seeded ordering is independent of "now". */
const T0 = Date.UTC(2026, 0, 5, 3, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface AnnouncementBody {
  id: string;
  title: string;
  body: string;
  format: AnnouncementFormat;
  status: AnnouncementStatus;
  audience: AnnouncementAudience;
  department: { id: number; name: string } | null;
  sentAt: string | null;
  sentCount: number;
  createdBy: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface ListBody {
  data: AnnouncementBody[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

describe('Announcements (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;

  let staffIds: Record<string, string> = {};
  let sessions: Record<string, Session> = {};

  /** Every announcement this file created — deleted BY ID in `afterAll`. */
  const createdIds: string[] = [];
  /** This file's own departments — deleted by id AFTER the announcements. */
  const deptIds: number[] = [];

  const dept = { active: 0, second: 0, gone: 0, reserved: 0 };

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

  const list = async (qs: string, email = ADMIN): Promise<ListBody> =>
    (
      await as(email)
        .agent.get(url(`/announcements${qs}`))
        .expect(200)
    ).body as ListBody;

  const post = (email: string, body: unknown) =>
    as(email)
      .agent.post(url('/announcements'))
      .set('x-csrf-token', as(email).token)
      .send(body as object);

  const patch = (email: string, id: string, body: unknown) =>
    as(email)
      .agent.patch(url(`/announcements/${id}`))
      .set('x-csrf-token', as(email).token)
      .send(body as object);

  const del = (email: string, id: string) =>
    as(email)
      .agent.delete(url(`/announcements/${id}`))
      .set('x-csrf-token', as(email).token);

  /** POST as `email`, expect 201, and track the id for teardown. */
  const createViaApi = async (
    body: Record<string, unknown>,
    email = ADMIN,
  ): Promise<AnnouncementBody> => {
    const res = await post(email, body);
    if (res.status === 201) {
      createdIds.push((res.body as AnnouncementBody).id);
    }
    expect(res.status).toBe(201);
    return res.body as AnnouncementBody;
  };

  /** Direct Prisma insert — the only way to get a SENT row in phase 1 (D-1). Tracked for teardown. */
  const seed = async (data: {
    title: string;
    body?: string;
    status?: AnnouncementStatus;
    audience?: AnnouncementAudience;
    departmentId?: number | null;
    createdById?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<string> => {
    const status = data.status ?? AnnouncementStatus.DRAFT;
    const { id } = await prisma.announcement.create({
      data: {
        title: data.title,
        body: data.body ?? '',
        status,
        audience: data.audience ?? AnnouncementAudience.ALL,
        departmentId: data.departmentId ?? null,
        createdById:
          data.createdById === undefined ? staffIds[ADMIN] : data.createdById,
        ...(status === AnnouncementStatus.SENT
          ? { sentAt: at(5), sentCount: 42 }
          : {}),
        createdAt: data.createdAt ?? at(0),
        updatedAt: data.updatedAt ?? at(0),
      },
      select: { id: true },
    });
    createdIds.push(id);
    return id;
  };

  const rawRow = (id: string) =>
    prisma.announcement.findUnique({ where: { id } });

  /** How many rows carry `marker` in their title — for "nothing written" assertions. */
  const countTitled = (marker: string) =>
    prisma.announcement.count({ where: { title: { contains: marker } } });

  const makeDept = async (
    suffix: string,
    extra: { deletedAt?: Date; isSystemReserved?: boolean } = {},
  ): Promise<number> => {
    const { id } = await prisma.department.create({
      data: { name: `${DEPT_PREFIX}${suffix}`, ...extra },
      select: { id: true },
    });
    deptIds.push(id);
    return id;
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);

    // Crash recovery ONLY: a previous run that died before `afterAll` may have left rows behind.
    // Scoped to this file's unique title root and department prefix — never a broad delete.
    await prisma.announcement.deleteMany({
      where: { title: { startsWith: ROOT } },
    });
    await prisma.$executeRawUnsafe(
      `DELETE FROM departments WHERE name LIKE '${DEPT_PREFIX}%'`,
    );
    await purgeE2eUsers(prisma, SU_PREFIX);

    dept.active = await makeDept('active');
    dept.second = await makeDept('second');
    dept.gone = await makeDept('gone', { deletedAt: new Date() });
    dept.reserved = await makeDept('reserved', { isSystemReserved: true });

    // Staff belong to the SHARED e2e option department, never to one of ours: a staff FK is
    // `Restrict`, and it would block the AC-11 hard delete and the teardown.
    const options = await ensureE2eOptions(prisma);
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
  }, 120_000);

  afterAll(async () => {
    // Announcements first (by id), THEN our departments (by id), then our staff (by email prefix).
    // Raw Prisma, so this also HARD-deletes the rows the API soft-deleted (ANNOUNCE-API-5) — a
    // soft-deleted fixture is still a real row, tracked in `createdIds` like any other.
    if (createdIds.length > 0) {
      await prisma.announcement.deleteMany({
        where: { id: { in: createdIds } },
      });
    }
    if (deptIds.length > 0) {
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    }
    await purgeE2eUsers(prisma, SU_PREFIX);
    await clearThrottleCounters(redis);
    await app.close();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-1 — the migrated table
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-1 — the announcements table', () => {
    it('has the columns, defaults and nullability the plan specifies', async () => {
      const cols = await prisma.$queryRaw<
        Array<{
          column_name: string;
          is_nullable: string;
          column_default: string | null;
          udt_name: string;
        }>
      >`SELECT column_name, is_nullable, column_default, udt_name
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'announcements'`;
      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));

      expect(Object.keys(byName).sort()).toEqual(
        [
          'id',
          'title',
          'body',
          'format',
          'status',
          'audience',
          'departmentId',
          'sentAt',
          'sentCount',
          'deletedAt', // ANNOUNCE-API-5
          'createdById',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      // ANNOUNCE-API-5 AC-1: nullable, no default — every pre-existing row got NULL.
      expect(byName.deletedAt.is_nullable).toBe('YES');
      expect(byName.deletedAt.column_default).toBeNull();
      expect(byName.deletedAt.udt_name).toBe('timestamp');
      expect(byName.format.udt_name).toBe('AnnouncementFormat');
      expect(byName.status.udt_name).toBe('AnnouncementStatus');
      expect(byName.audience.udt_name).toBe('AnnouncementAudience');
      expect(byName.format.column_default).toContain('TEXT');
      expect(byName.status.column_default).toContain('DRAFT');
      expect(byName.audience.column_default).toContain('ALL');
      expect(byName.body.column_default).toContain("''");
      expect(byName.sentCount.column_default).toBe('0');
      expect(byName.departmentId.udt_name).toBe('int4');
      expect(byName.departmentId.is_nullable).toBe('YES');
      expect(byName.createdById.is_nullable).toBe('YES');
      expect(byName.sentAt.is_nullable).toBe('YES');
      expect(byName.title.is_nullable).toBe('NO');
      // Unbounded text — the caps live in the DTO (house rule).
      expect(byName.title.udt_name).toBe('text');
      expect(byName.body.udt_name).toBe('text');
    });

    it('ANNOUNCE-API-5 AC-1 — the (deletedAt, createdAt) index exists', async () => {
      const idx = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
         WHERE tablename = 'announcements'
           AND indexname = 'announcements_deletedAt_createdAt_idx'`;
      expect(idx).toHaveLength(1);
      expect(idx[0].indexdef).toContain('("deletedAt", "createdAt")');
    });

    it('both FKs are ON DELETE SET NULL', async () => {
      const fks = await prisma.$queryRaw<
        Array<{ constraint_name: string; delete_rule: string }>
      >`SELECT rc.constraint_name, rc.delete_rule
          FROM information_schema.referential_constraints rc
          JOIN information_schema.table_constraints tc
            ON tc.constraint_name = rc.constraint_name
         WHERE tc.table_name = 'announcements'`;
      expect(
        Object.fromEntries(fks.map((f) => [f.constraint_name, f.delete_rule])),
      ).toEqual({
        announcements_departmentId_fkey: 'SET NULL',
        announcements_createdById_fkey: 'SET NULL',
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-2 / AC-3 — create
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('POST /announcements — AC-2 (defaults) and AC-3 (forbidden keys)', () => {
    it('AC-2 title only → 201 DRAFT/TEXT/ALL, body "", no department, never sent, authored by the session user', async () => {
      const body = await createViaApi({ title: `  ${ROOT} title only  ` });

      expect(body).toMatchObject({
        title: `${ROOT} title only`,
        body: '',
        format: AnnouncementFormat.TEXT,
        status: AnnouncementStatus.DRAFT,
        audience: AnnouncementAudience.ALL,
        department: null,
        sentAt: null,
        sentCount: 0,
        createdBy: {
          id: staffIds[ADMIN],
          firstName: 'E2E',
          lastName: SystemRole.ADMIN,
        },
      });
      expect(body).not.toHaveProperty('departmentId');
      expect(body).not.toHaveProperty('createdById');

      const row = await rawRow(body.id);
      expect(row).toMatchObject({
        status: AnnouncementStatus.DRAFT,
        format: AnnouncementFormat.TEXT,
        audience: AnnouncementAudience.ALL,
        departmentId: null,
        body: '',
        sentAt: null,
        sentCount: 0,
        createdById: staffIds[ADMIN],
      });
    });

    it('accepts body + format FLEX', async () => {
      const body = await createViaApi({
        title: `${ROOT} flex`,
        body: '  เนื้อหา  ',
        format: AnnouncementFormat.FLEX,
      });
      expect(body.body).toBe('เนื้อหา');
      expect(body.format).toBe(AnnouncementFormat.FLEX);
    });

    it.each([
      ['status', AnnouncementStatus.SENT],
      ['sentAt', '2026-09-22T00:00:00.000Z'],
      ['sentCount', 5],
      ['createdById', 'clx_attacker'],
      ['id', 'clx_chosen_id'],
      ['unknownKey', 'x'],
    ])('AC-3 a body with `%s` → 400, nothing written', async (key, value) => {
      const marker = `${ROOT} ac3 ${key}`;
      const res = await post(ADMIN, { title: marker, [key]: value }).expect(
        400,
      );
      expect((res.body as { message: string[] }).message.join(' ')).toContain(
        `property ${key} should not exist`,
      );
      expect(await countTitled(marker)).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-4 — validation on POST and PATCH
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-4 — field validation', () => {
    let target = '';

    beforeAll(async () => {
      target = await seed({ title: `${ROOT} ac4 target` });
    });

    it.each([
      ['a whitespace-only title', { title: '    ' }],
      ['a 101-character title', { title: `${ROOT} ac4 ${'ก'.repeat(90)}` }],
    ])('POST with %s → 400', async (_label, body) => {
      await post(ADMIN, body).expect(400);
      expect(await countTitled(`${ROOT} ac4 ก`)).toBe(0);
    });

    it.each([
      ['a 1001-character body', { body: 'ข'.repeat(1001) }],
      ['a bad format', { format: 'HTML' }],
      ['a bad audience', { audience: 'STAFF' }],
      ['a string departmentId', { departmentId: '3' }],
      [
        'a departmentId beyond int4 (400, not a Prisma 500)',
        {
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: 3_000_000_000,
        },
      ],
      ['a null body', { body: null }],
    ])('POST with %s → 400, nothing written', async (label, extra) => {
      const marker = `${ROOT} ac4 post ${label}`;
      await post(ADMIN, { title: marker, ...extra }).expect(400);
      expect(await countTitled(marker)).toBe(0);
    });

    it('a 100-character title and a 1000-character body (after trimming) are accepted', async () => {
      const body = await createViaApi({
        title: ` ${ROOT}${'ก'.repeat(100 - ROOT.length)} `,
        body: ` ${'ข'.repeat(1000)} `,
      });
      expect(body.title).toHaveLength(100);
      expect(body.body).toHaveLength(1000);
    });

    it.each([
      ['a whitespace-only title', { title: '   ' }],
      ['a null title', { title: null }],
      ['a 101-character title', { title: 'ก'.repeat(101) }],
      ['a 1001-character body', { body: 'ข'.repeat(1001) }],
      ['a bad format', { format: 'HTML' }],
      ['a bad audience', { audience: 'STAFF' }],
      ['a forbidden key', { status: AnnouncementStatus.SENT }],
    ])('PATCH with %s → 400, row unchanged', async (_label, body) => {
      const before = await rawRow(target);
      await patch(ADMIN, target, body).expect(400);
      expect(await rawRow(target)).toEqual(before);
    });

    it('PATCH {} → 400 with the single-string UPDATE_EMPTY message (S-2), row unchanged', async () => {
      const before = await rawRow(target);
      const res = await patch(ADMIN, target, {}).expect(400);
      expect((res.body as { message: unknown }).message).toBe(
        ANNOUNCEMENT_UPDATE_EMPTY,
      );
      expect(await rawRow(target)).toEqual(before);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-5 — the audience / department invariant (D-3)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-5 — audience/department rules', () => {
    const expect400 = async (
      res: request.Test,
      message: string,
    ): Promise<void> => {
      const r = await res.expect(400);
      expect((r.body as { message: unknown }).message).toBe(message);
    };

    describe('on POST', () => {
      it('DEPARTMENT without departmentId → 400 REQUIRED', async () => {
        await expect400(
          post(ADMIN, {
            title: `${ROOT} ac5 nodept`,
            audience: AnnouncementAudience.DEPARTMENT,
          }),
          ANNOUNCEMENT_DEPARTMENT_REQUIRED,
        );
        await expect400(
          post(ADMIN, {
            title: `${ROOT} ac5 nulldept`,
            audience: AnnouncementAudience.DEPARTMENT,
            departmentId: null,
          }),
          ANNOUNCEMENT_DEPARTMENT_REQUIRED,
        );
        expect(await countTitled(`${ROOT} ac5 n`)).toBe(0);
      });

      it('DEPARTMENT + an unknown department → 400 INVALID (not 404)', async () => {
        await expect400(
          post(ADMIN, {
            title: `${ROOT} ac5 unknown`,
            audience: AnnouncementAudience.DEPARTMENT,
            departmentId: 2_000_000_000,
          }),
          ANNOUNCEMENT_DEPARTMENT_INVALID,
        );
      });

      it('DEPARTMENT + a soft-deleted department → the same 400 INVALID', async () => {
        await expect400(
          post(ADMIN, {
            title: `${ROOT} ac5 gone`,
            audience: AnnouncementAudience.DEPARTMENT,
            departmentId: dept.gone,
          }),
          ANNOUNCEMENT_DEPARTMENT_INVALID,
        );
      });

      it('ALL + a departmentId → 400 NOT_ALLOWED (never silently cleared)', async () => {
        await expect400(
          post(ADMIN, {
            title: `${ROOT} ac5 allwithdept`,
            audience: AnnouncementAudience.ALL,
            departmentId: dept.active,
          }),
          ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
        );
        await expect400(
          post(ADMIN, {
            title: `${ROOT} ac5 impliedall`,
            departmentId: dept.active,
          }),
          ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
        );
        expect(await countTitled(`${ROOT} ac5 `)).toBe(0);
      });

      it('DEPARTMENT + an active department → 201 with the department resolved', async () => {
        const body = await createViaApi({
          title: `${ROOT} ac5 valid`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        expect(body.audience).toBe(AnnouncementAudience.DEPARTMENT);
        expect(body.department).toEqual({
          id: dept.active,
          name: `${DEPT_PREFIX}active`,
        });
      });

      it('S-5: a reserved department is the same 400 for an ADMIN, and allowed for a SUPER_ADMIN', async () => {
        await expect400(
          post(ADMIN, {
            title: `${ROOT} ac5 reserved admin`,
            audience: AnnouncementAudience.DEPARTMENT,
            departmentId: dept.reserved,
          }),
          ANNOUNCEMENT_DEPARTMENT_INVALID,
        );
        const body = await createViaApi(
          {
            title: `${ROOT} ac5 reserved super`,
            audience: AnnouncementAudience.DEPARTMENT,
            departmentId: dept.reserved,
          },
          SUPER,
        );
        expect(body.department?.id).toBe(dept.reserved);
        expect(body.createdBy?.id).toBe(staffIds[SUPER]);
      });
    });

    describe('on PATCH (merged state)', () => {
      it('ALL draft → { audience: DEPARTMENT } alone → 400 REQUIRED', async () => {
        const id = await seed({ title: `${ROOT} ac5p all` });
        const before = await rawRow(id);
        await expect400(
          patch(ADMIN, id, { audience: AnnouncementAudience.DEPARTMENT }),
          ANNOUNCEMENT_DEPARTMENT_REQUIRED,
        );
        expect(await rawRow(id)).toEqual(before);
      });

      it('ALL draft → { departmentId } alone → 400 NOT_ALLOWED', async () => {
        const id = await seed({ title: `${ROOT} ac5p all2` });
        await expect400(
          patch(ADMIN, id, { departmentId: dept.active }),
          ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
        );
      });

      it('ALL draft → DEPARTMENT + active department → 200', async () => {
        const id = await seed({ title: `${ROOT} ac5p switch` });
        const res = await patch(ADMIN, id, {
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        }).expect(200);
        expect((res.body as AnnouncementBody).department?.id).toBe(dept.active);
      });

      it('DEPARTMENT draft → { audience: DEPARTMENT } alone keeps the stored department → 200', async () => {
        const id = await seed({
          title: `${ROOT} ac5p keep`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        const res = await patch(ADMIN, id, {
          audience: AnnouncementAudience.DEPARTMENT,
        }).expect(200);
        expect((res.body as AnnouncementBody).department?.id).toBe(dept.active);
      });

      it('DEPARTMENT draft → { audience: ALL } alone clears the department → 200', async () => {
        const id = await seed({
          title: `${ROOT} ac5p clear`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        const res = await patch(ADMIN, id, {
          audience: AnnouncementAudience.ALL,
        }).expect(200);
        const body = res.body as AnnouncementBody;
        expect(body.audience).toBe(AnnouncementAudience.ALL);
        expect(body.department).toBeNull();
        expect((await rawRow(id))?.departmentId).toBeNull();
      });

      it('DEPARTMENT draft → { audience: ALL, departmentId: null } → 200', async () => {
        const id = await seed({
          title: `${ROOT} ac5p clear2`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        await patch(ADMIN, id, {
          audience: AnnouncementAudience.ALL,
          departmentId: null,
        }).expect(200);
        expect((await rawRow(id))?.departmentId).toBeNull();
      });

      it('DEPARTMENT draft → { audience: ALL, departmentId: N } → 400 NOT_ALLOWED', async () => {
        const id = await seed({
          title: `${ROOT} ac5p allN`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        await expect400(
          patch(ADMIN, id, {
            audience: AnnouncementAudience.ALL,
            departmentId: dept.second,
          }),
          ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
        );
      });

      it('DEPARTMENT draft → { departmentId: null } → 400 REQUIRED', async () => {
        const id = await seed({
          title: `${ROOT} ac5p nulldept`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        await expect400(
          patch(ADMIN, id, { departmentId: null }),
          ANNOUNCEMENT_DEPARTMENT_REQUIRED,
        );
      });

      it('DEPARTMENT draft → a soft-deleted department → 400 INVALID', async () => {
        const id = await seed({
          title: `${ROOT} ac5p gone`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        await expect400(
          patch(ADMIN, id, { departmentId: dept.gone }),
          ANNOUNCEMENT_DEPARTMENT_INVALID,
        );
      });

      it('DEPARTMENT draft → another active department → 200', async () => {
        const id = await seed({
          title: `${ROOT} ac5p move`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: dept.active,
        });
        const res = await patch(ADMIN, id, {
          departmentId: dept.second,
        }).expect(200);
        expect((res.body as AnnouncementBody).department?.id).toBe(dept.second);
      });

      it('edge: a department soft-deleted AFTER drafting still reads, but the next title-only PATCH → 400', async () => {
        const later = await makeDept('later');
        const id = await seed({
          title: `${ROOT} ac5p later`,
          audience: AnnouncementAudience.DEPARTMENT,
          departmentId: later,
        });
        await prisma.department.update({
          where: { id: later },
          data: { deletedAt: new Date() },
        });

        const read = await as(VIEWER)
          .agent.get(url(`/announcements/${id}`))
          .expect(200);
        expect((read.body as AnnouncementBody).department).toEqual({
          id: later,
          name: `${DEPT_PREFIX}later`,
        });

        const before = await rawRow(id);
        await expect400(
          patch(ADMIN, id, { title: `${ROOT} ac5p later renamed` }),
          ANNOUNCEMENT_DEPARTMENT_INVALID,
        );
        expect(await rawRow(id)).toEqual(before);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-6 — the list
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-6 — GET /announcements', () => {
    const f = { a: '', b: '', tieHigh: '', tieLow: '' };

    beforeAll(async () => {
      f.a = await seed({
        title: `${LIST} Alpha`,
        body: `ข้อความ ${BODY_ONLY}`,
        createdAt: at(2),
      });
      f.b = await seed({
        title: `${LIST} beta`,
        status: AnnouncementStatus.SENT,
        createdAt: at(1),
      });
      // An exact createdAt tie — the order is then decided by `id DESC`.
      const t1 = await seed({ title: `${LIST} tie one`, createdAt: at(0) });
      const t2 = await seed({ title: `${LIST} tie two`, createdAt: at(0) });
      [f.tieHigh, f.tieLow] = t1 > t2 ? [t1, t2] : [t2, t1];
    });

    it('newest first; an exact createdAt tie is broken by id DESC', async () => {
      const body = await list(`?q=${LIST}`);
      expect(body.data.map((r) => r.id)).toEqual([
        f.a,
        f.b,
        f.tieHigh,
        f.tieLow,
      ]);
      expect(body.meta).toEqual({
        page: 1,
        limit: 10,
        total: 4,
        totalPages: 1,
      });
    });

    it.each([
      ['draft', () => [f.a, f.tieHigh, f.tieLow]],
      ['sent', () => [f.b]],
      ['all', () => [f.a, f.b, f.tieHigh, f.tieLow]],
    ])('status=%s filters correctly', async (status, expected) => {
      const body = await list(`?q=${LIST}&status=${status}`);
      expect(body.data.map((r) => r.id)).toEqual(expected());
      expect(body.meta.total).toBe(expected().length);
    });

    it('status=draft never returns a SENT row, and status=sent never a DRAFT one', async () => {
      const drafts = await list('?status=draft&limit=50');
      expect(
        drafts.data.every((r) => r.status === AnnouncementStatus.DRAFT),
      ).toBe(true);
      const sent = await list('?status=sent&limit=50');
      expect(sent.data.every((r) => r.status === AnnouncementStatus.SENT)).toBe(
        true,
      );
    });

    it('q is case-insensitive on the title', async () => {
      const body = await list(
        `?q=${encodeURIComponent(`  ${LIST.toUpperCase()} ALPHA  `)}`,
      );
      expect(body.data.map((r) => r.id)).toEqual([f.a]);
    });

    it('q does not search the body', async () => {
      const body = await list(`?q=${BODY_ONLY}`);
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    it('a whitespace-only q is no filter', async () => {
      const plain = await list('');
      const blank = await list(`?q=${encodeURIComponent('   ')}`);
      expect(blank.meta.total).toBe(plain.meta.total);
    });

    it('% and _ in q match literally (escaped — Prisma contains does not)', async () => {
      const pct = await seed({ title: `${LIT} 100% off` });
      const zero = await seed({ title: `${LIT} 1000 off` });
      const under = await seed({ title: `${LIT}_under` });

      const byPercent = await list(`?q=${encodeURIComponent(`${LIT} 100%`)}`);
      expect(byPercent.data.map((r) => r.id)).toEqual([pct]);

      const byUnderscore = await list(`?q=${encodeURIComponent(`${LIT}_`)}`);
      expect(byUnderscore.data.map((r) => r.id)).toEqual([under]);

      const all = await list(`?q=${LIT}`);
      expect(all.data.map((r) => r.id).sort()).toEqual(
        [pct, zero, under].sort(),
      );
    });

    it('a page past the end → data [] with a correct meta', async () => {
      const body = await list(`?q=${LIST}&page=99`);
      expect(body).toEqual({
        data: [],
        meta: { page: 99, limit: 10, total: 4, totalPages: 1 },
      });
    });

    it('limit=20 and limit=50 are accepted', async () => {
      expect((await list(`?q=${LIST}&limit=20`)).meta.limit).toBe(20);
      expect((await list(`?q=${LIST}&limit=50`)).meta.limit).toBe(50);
    });

    it.each([
      ['limit=25', '?limit=25'],
      ['limit=0', '?limit=0'],
      ['page=0', '?page=0'],
      ['status=DRAFT (uppercase)', '?status=DRAFT'],
      ['status=nope', '?status=nope'],
      ['q over 100 characters', `?q=${'x'.repeat(101)}`],
      ['an unknown key', '?foo=1'],
    ])('%s → 400', async (_label, qs) => {
      await as(ADMIN)
        .agent.get(url(`/announcements${qs}`))
        .expect(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-7 — detail
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-7 — GET /announcements/:id', () => {
    it('→ 200 with the record', async () => {
      const id = await seed({
        title: `${ROOT} ac7`,
        body: 'รายละเอียด',
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: dept.active,
      });
      const res = await as(ADMIN)
        .agent.get(url(`/announcements/${id}`))
        .expect(200);
      expect(res.body).toEqual({
        id,
        title: `${ROOT} ac7`,
        body: 'รายละเอียด',
        format: AnnouncementFormat.TEXT,
        status: AnnouncementStatus.DRAFT,
        audience: AnnouncementAudience.DEPARTMENT,
        department: { id: dept.active, name: `${DEPT_PREFIX}active` },
        sentAt: null,
        sentCount: 0,
        createdBy: {
          id: staffIds[ADMIN],
          firstName: 'E2E',
          lastName: SystemRole.ADMIN,
        },
        createdAt: at(0).toISOString(),
        updatedAt: at(0).toISOString(),
      });
    });

    it.each([
      ['an unknown cuid', 'cnotarealannouncement000000'],
      ['a malformed id', 'not%20a%20cuid'],
    ])('%s → 404', async (_label, id) => {
      const res = await as(ADMIN)
        .agent.get(url(`/announcements/${id}`))
        .expect(404);
      expect((res.body as { message: unknown }).message).toBe(
        ANNOUNCEMENT_NOT_FOUND,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-8 — update
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-8 — PATCH /announcements/:id', () => {
    it('a DRAFT → 200 with the updated record, updatedAt advanced', async () => {
      const id = await seed({ title: `${ROOT} ac8 draft` });
      const before = await rawRow(id);

      const res = await patch(ADMIN, id, {
        title: `  ${ROOT} ac8 edited  `,
        body: 'ใหม่',
        format: AnnouncementFormat.FLEX,
      }).expect(200);
      const body = res.body as AnnouncementBody;

      expect(body).toMatchObject({
        id,
        title: `${ROOT} ac8 edited`,
        body: 'ใหม่',
        format: AnnouncementFormat.FLEX,
        status: AnnouncementStatus.DRAFT,
      });
      expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(
        before!.updatedAt.getTime(),
      );
      expect(body.createdAt).toBe(before!.createdAt.toISOString());
      // The author is the CREATOR — an edit by someone else does not re-attribute it.
      expect(body.createdBy?.id).toBe(staffIds[ADMIN]);
    });

    it('a SUPER_ADMIN may edit an ADMIN draft; body "" clears it', async () => {
      const id = await seed({ title: `${ROOT} ac8 clear`, body: 'x' });
      const res = await patch(SUPER, id, { body: '' }).expect(200);
      expect((res.body as AnnouncementBody).body).toBe('');
    });

    it('unknown id → 404', async () => {
      const res = await patch(ADMIN, 'cnotarealannouncement000000', {
        title: 'x',
      }).expect(404);
      expect((res.body as { message: unknown }).message).toBe(
        ANNOUNCEMENT_NOT_FOUND,
      );
    });

    it('a seeded SENT row → 409 and the row is byte-identical afterwards', async () => {
      const id = await seed({
        title: `${ROOT} ac8 sent`,
        status: AnnouncementStatus.SENT,
      });
      const before = await rawRow(id);
      const res = await patch(ADMIN, id, { title: `${ROOT} hijack` }).expect(
        409,
      );
      expect((res.body as { message: unknown }).message).toBe(
        ANNOUNCEMENT_SENT_IMMUTABLE,
      );
      expect(await rawRow(id)).toEqual(before);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-9 — delete
  // ────────────────────────────────────────────────────────────────────────────────────────────
  // ANNOUNCE-API-5 (plan D-1) — DELETE is now a SOFT delete for DRAFT and SENT alike. The rows stay
  // real rows, so they are in `createdIds` and `afterAll` hard-deletes them BY ID like any other.
  describe('AC-9 / ANNOUNCE-API-5 AC-2 — DELETE /announcements/:id is a soft delete', () => {
    /** The row after a soft delete: `deletedAt` set, every other column but `updatedAt` untouched. */
    const expectSoftDeleted = async (
      id: string,
      before: NonNullable<Awaited<ReturnType<typeof rawRow>>>,
      startedAt: number,
    ) => {
      const after = await rawRow(id);
      expect(after).not.toBeNull(); // still a real row — never a hard delete
      expect(after!.deletedAt).toBeInstanceOf(Date);
      expect(after!.deletedAt!.getTime()).toBeGreaterThanOrEqual(
        startedAt - 1_000,
      );
      // `toEqual` treats an `undefined` property as absent: compare every OTHER column.
      const strip = (r: typeof before) => ({
        ...r,
        deletedAt: undefined,
        updatedAt: undefined,
      });
      expect(strip(after!)).toEqual(strip(before));
      expect(Object.keys(after!).sort()).toEqual(Object.keys(before).sort());
      expect(before.deletedAt).toBeNull();
    };

    it('a DRAFT → 204 with an empty body; the row survives with deletedAt set; a second DELETE is a coded 404', async () => {
      const id = await seed({ title: `${ROOT} ac9 draft`, body: 'ร่าง' });
      const before = (await rawRow(id))!;
      const startedAt = Date.now();
      const res = await del(ADMIN, id).expect(204);
      expect(res.text).toBe('');
      await expectSoftDeleted(id, before, startedAt);

      const again = await del(ADMIN, id).expect(404);
      expect(again.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: ANNOUNCEMENT_NOT_FOUND,
        code: 'ANNOUNCEMENT_NOT_FOUND',
      });
    });

    it('a seeded SENT row → 204 (no longer 409); the row survives with deletedAt set and sentAt/sentCount intact', async () => {
      const id = await seed({
        title: `${ROOT} ac9 sent`,
        status: AnnouncementStatus.SENT,
      });
      const before = (await rawRow(id))!;
      const startedAt = Date.now();
      await del(SUPER, id).expect(204);
      await expectSoftDeleted(id, before, startedAt);
      const after = (await rawRow(id))!;
      expect(after.status).toBe(AnnouncementStatus.SENT);
      expect(after.sentCount).toBe(42);
      expect(after.sentAt).toEqual(at(5));
    });

    it('AC-6 unknown id → coded 404 ANNOUNCEMENT_NOT_FOUND', async () => {
      const res = await del(ADMIN, 'cnotarealannouncement000000').expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: ANNOUNCEMENT_NOT_FOUND,
        code: 'ANNOUNCEMENT_NOT_FOUND',
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // ANNOUNCE-API-5 AC-3 — a soft-deleted row is invisible everywhere
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('ANNOUNCE-API-5 AC-3 — a soft-deleted row disappears from every read and write', () => {
    const DEL = `${ROOT}softdel`;
    const f = { draft: '', sent: '', live: '' };

    type Totals = { all: number; draft: number; sent: number };
    const totals = async (): Promise<Totals> => ({
      all: (await list(`?q=${DEL}&status=all`)).meta.total,
      draft: (await list(`?q=${DEL}&status=draft`)).meta.total,
      sent: (await list(`?q=${DEL}&status=sent`)).meta.total,
    });
    const idsIn = async (status: string) =>
      (await list(`?q=${DEL}&status=${status}&limit=50`)).data.map((r) => r.id);

    beforeAll(async () => {
      f.draft = await seed({ title: `${DEL} draft one`, createdAt: at(3) });
      f.sent = await seed({
        title: `${DEL} sent one`,
        status: AnnouncementStatus.SENT,
        createdAt: at(2),
      });
      f.live = await seed({ title: `${DEL} live control`, createdAt: at(1) });
    });

    it('the list (all / draft / sent, narrowed by q) drops the row and meta.total drops by one — per filter', async () => {
      const t0 = await totals();
      expect(t0).toEqual({ all: 3, draft: 2, sent: 1 });
      expect(
        (await list(`?q=${encodeURIComponent(`${DEL} draft one`)}`)).meta.total,
      ).toBe(1);

      await del(ADMIN, f.draft).expect(204);
      expect(await totals()).toEqual({ all: 2, draft: 1, sent: 1 });
      for (const status of ['all', 'draft', 'sent']) {
        expect(await idsIn(status)).not.toContain(f.draft);
      }
      // `q` matching its exact title finds nothing any more.
      const exact = await list(`?q=${encodeURIComponent(`${DEL} draft one`)}`);
      expect(exact.data).toEqual([]);
      expect(exact.meta.total).toBe(0);

      await del(ADMIN, f.sent).expect(204);
      expect(await totals()).toEqual({ all: 1, draft: 1, sent: 0 });
      for (const status of ['all', 'draft', 'sent']) {
        expect(await idsIn(status)).not.toContain(f.sent);
      }
      // The live control is untouched by either delete.
      expect(await idsIn('all')).toEqual([f.live]);
    });

    it('GET /:id → the same 404 as an unknown id, for all three roles', async () => {
      for (const email of [SUPER, ADMIN, VIEWER]) {
        for (const id of [f.draft, f.sent]) {
          const res = await as(email)
            .agent.get(url(`/announcements/${id}`))
            .expect(404);
          expect((res.body as { message: unknown }).message).toBe(
            ANNOUNCEMENT_NOT_FOUND,
          );
        }
      }
    });

    it('a second DELETE → coded 404; PATCH → 404; the row is not modified by either', async () => {
      for (const id of [f.draft, f.sent]) {
        const before = await rawRow(id);
        const d = await del(SUPER, id).expect(404);
        expect((d.body as { code?: string }).code).toBe(
          'ANNOUNCEMENT_NOT_FOUND',
        );
        const p = await patch(ADMIN, id, { title: `${ROOT} resurrect` }).expect(
          404,
        );
        expect((p.body as { message: unknown }).message).toBe(
          ANNOUNCEMENT_NOT_FOUND,
        );
        expect(await rawRow(id)).toEqual(before);
      }
      // (`POST /:id/send` → 404 with no LINE call is proven in announcements-send.e2e-spec.ts, where
      // the fake client and the fetch tripwire live.)
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // ANNOUNCE-API-5 AC-5 — PATCH vs a concurrent DELETE
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('ANNOUNCE-API-5 AC-5 — PATCH racing a DELETE', () => {
    const waitFor = async (
      predicate: () => Promise<boolean>,
      timeoutMs: number,
    ): Promise<boolean> => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await predicate()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };

    it('a PATCH blocked behind a DELETE (the row lock + the deletedAt write, then commit) ends as 404, not 409', async () => {
      const id = await seed({ title: `${ROOT} ac5x race` });

      // Hold the row exactly as `remove` does: FOR UPDATE, then the guarded deletedAt write, then wait.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let lockedSignal!: () => void;
      const locked = new Promise<void>((r) => (lockedSignal = r));
      const holder = prisma.$transaction(
        async (t) => {
          await t.$queryRaw`SELECT "id" FROM "announcements" WHERE "id" = ${id} FOR UPDATE`;
          await t.announcement.updateMany({
            where: { id, deletedAt: null },
            data: { deletedAt: new Date() },
          });
          lockedSignal();
          await gate;
        },
        { timeout: 20_000 },
      );
      await locked;

      // The PATCH's first read is MVCC (not blocked) and sees a live DRAFT; its guarded write blocks.
      const patchReq = patch(ADMIN, id, { title: `${ROOT} ac5x edited` }).then(
        (r) => r,
      );
      const patchBlocked = await waitFor(async () => {
        const [{ n }] = await prisma.$queryRaw<[{ n: number }]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query ILIKE '%announcements%'`;
        return n > 0;
      }, 10_000);

      release();
      await holder;
      const res = await patchReq;

      expect(patchBlocked).toBe(true);
      expect(res.status).toBe(404);
      expect((res.body as { message: unknown }).message).toBe(
        ANNOUNCEMENT_NOT_FOUND,
      );
      const row = await rawRow(id);
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.title).toBe(`${ROOT} ac5x race`); // the blocked PATCH never landed
    });

    it('a PATCH on a live SENT row is still 409 ANNOUNCEMENT_SENT_IMMUTABLE, with the reworded message', async () => {
      const id = await seed({
        title: `${ROOT} ac5x sent`,
        status: AnnouncementStatus.SENT,
      });
      const res = await patch(ADMIN, id, { title: `${ROOT} x` }).expect(409);
      expect((res.body as { message: unknown }).message).toBe(
        'A sent announcement cannot be edited.',
      );
      expect(ANNOUNCEMENT_SENT_IMMUTABLE).toBe(
        'A sent announcement cannot be edited.',
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // ANNOUNCE-API-5 AC-6 — DELETE RBAC / session / CSRF leave the row live
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('ANNOUNCE-API-5 AC-6 — refused DELETEs soft-delete nothing', () => {
    it('VIEWER (valid CSRF) → 403; no session (minted token) → 401; ADMIN without x-csrf-token → 403 — deletedAt stays null', async () => {
      const id = await seed({ title: `${ROOT} ac6x target` });
      const before = await rawRow(id);

      await del(VIEWER, id).expect(403);

      const anon = request.agent(server());
      const csrf = await anon.get(url('/auth/system/csrf')).expect(200);
      await anon
        .delete(url(`/announcements/${id}`))
        .set('x-csrf-token', (csrf.body as { csrfToken: string }).csrfToken)
        .expect(401);

      await as(ADMIN)
        .agent.delete(url(`/announcements/${id}`))
        .expect(403);

      const after = await rawRow(id);
      expect(after?.deletedAt).toBeNull();
      expect(after).toEqual(before);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-10 — RBAC, session and CSRF
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-10 — RBAC / session / CSRF', () => {
    let target = '';

    beforeAll(async () => {
      target = await seed({ title: `${ROOT} ac10 target` });
    });

    it('VIEWER → 200 on both GETs', async () => {
      const body = await list(
        `?q=${encodeURIComponent(`${ROOT} ac10`)}`,
        VIEWER,
      );
      expect(body.data.map((r) => r.id)).toEqual([target]);
      await as(VIEWER)
        .agent.get(url(`/announcements/${target}`))
        .expect(200);
    });

    it('VIEWER (with CSRF) → 403 on POST, nothing written', async () => {
      const marker = `${ROOT} ac10 viewer post`;
      await post(VIEWER, { title: marker }).expect(403);
      expect(await countTitled(marker)).toBe(0);
    });

    it('VIEWER (with CSRF) → 403 on PATCH and DELETE, row unchanged', async () => {
      const before = await rawRow(target);
      await patch(VIEWER, target, { title: `${ROOT} viewer edit` }).expect(403);
      await del(VIEWER, target).expect(403);
      expect(await rawRow(target)).toEqual(before);
    });

    it('SUPER_ADMIN and ADMIN → 200 on both GETs', async () => {
      for (const email of [SUPER, ADMIN]) {
        await as(email).agent.get(url('/announcements')).expect(200);
        await as(email)
          .agent.get(url(`/announcements/${target}`))
          .expect(200);
      }
    });

    it('no session → 401 on both GETs', async () => {
      await request(server()).get(url('/announcements')).expect(401);
      await request(server())
        .get(url(`/announcements/${target}`))
        .expect(401);
    });

    it('no session (but a valid CSRF pair) → 401 on POST, PATCH and DELETE, nothing written', async () => {
      const agent = request.agent(server());
      const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
      const token = (csrf.body as { csrfToken: string }).csrfToken;
      const marker = `${ROOT} ac10 anon post`;
      const before = await rawRow(target);

      await agent
        .post(url('/announcements'))
        .set('x-csrf-token', token)
        .send({ title: marker })
        .expect(401);
      await agent
        .patch(url(`/announcements/${target}`))
        .set('x-csrf-token', token)
        .send({ title: 'x' })
        .expect(401);
      await agent
        .delete(url(`/announcements/${target}`))
        .set('x-csrf-token', token)
        .expect(401);

      expect(await countTitled(marker)).toBe(0);
      expect(await rawRow(target)).toEqual(before);
    });

    it('no session AND no CSRF token → 403 (the CSRF middleware runs before the guards)', async () => {
      await request(server())
        .post(url('/announcements'))
        .send({ title: `${ROOT} ac10 bare` })
        .expect(403);
    });

    it('ADMIN without x-csrf-token → 403 on POST, PATCH and DELETE, nothing written', async () => {
      const marker = `${ROOT} ac10 nocsrf`;
      const before = await rawRow(target);
      const agent = as(ADMIN).agent;

      const res = await agent
        .post(url('/announcements'))
        .send({ title: marker })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        INVALID_CSRF_TOKEN,
      );
      await agent
        .patch(url(`/announcements/${target}`))
        .send({ title: 'x' })
        .expect(403);
      await agent.delete(url(`/announcements/${target}`)).expect(403);

      expect(await countTitled(marker)).toBe(0);
      expect(await rawRow(target)).toEqual(before);
    });

    it('ADMIN with a forged x-csrf-token → 403', async () => {
      const before = await rawRow(target);
      await as(ADMIN)
        .agent.patch(url(`/announcements/${target}`))
        .set('x-csrf-token', 'forged-token')
        .send({ title: 'x' })
        .expect(403);
      expect(await rawRow(target)).toEqual(before);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-11 — hard delete of a referenced department / staff member
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-11 — SetNull FKs', () => {
    it('hard-deleting the department and the author nulls both FKs and keeps the announcement', async () => {
      // No staff member belongs to this department, so its `Restrict` FK cannot block the delete.
      const throwaway = await makeDept('throwaway');
      const id = await seed({
        title: `${ROOT} ac11`,
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: throwaway,
        createdById: staffIds[DOOMED],
      });

      // Raw Prisma: no route hard-deletes either row.
      await prisma.department.delete({ where: { id: throwaway } });
      await prisma.systemUser.delete({ where: { id: staffIds[DOOMED] } });

      const row = await rawRow(id);
      expect(row).not.toBeNull();
      expect(row?.departmentId).toBeNull();
      expect(row?.createdById).toBeNull();
      expect(row?.title).toBe(`${ROOT} ac11`);

      const res = await as(ADMIN)
        .agent.get(url(`/announcements/${id}`))
        .expect(200);
      const body = res.body as AnnouncementBody;
      expect(body.department).toBeNull();
      expect(body.createdBy).toBeNull();
      // The row still says DEPARTMENT — the PO chose SetNull; the next PATCH must pick a department.
      expect(body.audience).toBe(AnnouncementAudience.DEPARTMENT);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-12 — the OpenAPI contract
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-12 — /docs-json', () => {
    type Operation = { responses: Record<string, unknown>; tags?: string[] };
    type Doc = {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, { enum?: string[] }> };
    };
    let doc: Doc;

    beforeAll(() => {
      // `createE2eApp` does not mount Swagger (main.ts does), so build the same document here.
      doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      ) as unknown as Doc;
    });

    it('ANNOUNCE-API-5 — DELETE documents 204 and CODED 404/409, and describes the soft delete', () => {
      type Op = Operation & { description?: string; summary?: string };
      const op = doc.paths[`${API_BASE_PATH}/announcements/{id}`].delete as Op;
      const ref = (status: string) => JSON.stringify(op.responses[status]);
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(['204', '404', '409']),
      );
      expect(ref('404')).toContain('AnnouncementCodedErrorDto');
      expect(ref('409')).toContain('AnnouncementCodedErrorDto');
      expect(op.description).toMatch(/soft/i);
      expect(op.summary).toMatch(/soft/i);
    });

    it('documents all five operations with their success and error responses', () => {
      const collection = doc.paths[`${API_BASE_PATH}/announcements`];
      const item = doc.paths[`${API_BASE_PATH}/announcements/{id}`];

      const codes = (op: Operation) => Object.keys(op.responses).sort();
      expect(codes(collection.get)).toEqual(
        expect.arrayContaining(['200', '400', '401']),
      );
      expect(codes(collection.post)).toEqual(
        expect.arrayContaining(['201', '400', '401', '403']),
      );
      expect(codes(item.get)).toEqual(
        expect.arrayContaining(['200', '401', '404']),
      );
      expect(codes(item.patch)).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '409']),
      );
      expect(codes(item.delete)).toEqual(
        expect.arrayContaining(['204', '401', '403', '404', '409']),
      );
      for (const op of [
        collection.get,
        collection.post,
        item.get,
        item.patch,
        item.delete,
      ]) {
        expect(op.tags).toEqual(['Announcements']);
      }
    });

    it('publishes the three enums under their own names, and the filter separately (S-3)', () => {
      const s = doc.components.schemas;
      expect(s.AnnouncementFormat?.enum).toEqual(['TEXT', 'FLEX']);
      expect(s.AnnouncementStatus?.enum).toEqual(['DRAFT', 'SENT']);
      expect(s.AnnouncementAudience?.enum).toEqual(['ALL', 'DEPARTMENT']);
      expect(s.AnnouncementStatusFilter?.enum).toEqual([
        'all',
        'sent',
        'draft',
      ]);
    });

    it('publishes the request and response schemas', () => {
      const s = doc.components.schemas;
      for (const name of [
        'AnnouncementDto',
        'AnnouncementDepartmentDto',
        'AnnouncementCreatorDto',
        'PaginatedAnnouncementsResponseDto',
        'CreateAnnouncementDto',
        'UpdateAnnouncementDto',
      ]) {
        expect(s).toHaveProperty(name);
      }
    });
  });
});
