import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SystemRole, type CannedReply } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import {
  CANNED_REPLIES_LIMIT_EXCEEDED,
  CANNED_REPLY_NOT_FOUND,
  CANNED_REPLY_UPDATE_EMPTY,
} from '../src/canned-replies/canned-replies.constants';
import { CANNED_REPLY_ERROR_CODES } from '../src/canned-replies/dto/canned-reply-error.dto';
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
 * `ANNOUNCE-API-5` — `/canned-replies` CRUD (plan AC-11…AC-19, design §5.6).
 *
 * 🔴 THIS RUNS AGAINST THE SHARED DEV DATABASE, whose `canned_replies` table holds REAL rows — at
 * least the four migration-seeded defaults. The table is capped at 5 and several tests need an exact
 * count, so the file follows plan D-7 to the letter:
 * - `beforeAll` SNAPSHOTS every row (all columns);
 * - rows this file writes are tracked in `created` (API responses AND direct inserts) and titled
 *   `e2e-canned …`; the only broad delete is the crash-recovery sweep of that prefix;
 * - when a count needs lowering, OWN rows go first; a snapshotted row is deleted only if that is not
 *   enough, one at a time, and its full original columns are kept in `removed`;
 * - tests never PATCH or DELETE a row they did not create;
 * - the last test (and `afterAll`, as a net) deletes `created` by id, re-creates `removed` by id with
 *   their original `createdAt`/`updatedAt`, and ASSERTS the table equals the snapshot (AC-19).
 *
 * No LINE: this module never calls it, so no client override is needed.
 */

const SU_PREFIX = 'e2e-cannedsu-';
const PASSWORD = 'E2e-correct-horse-battery-1';

const SUPER = `${SU_PREFIX}super@easybook.local`;
const ADMIN = `${SU_PREFIX}admin@easybook.local`;
const VIEWER = `${SU_PREFIX}viewer@easybook.local`;

/** Every row this file writes has a title starting with this. No real canned reply does. */
const OWN = 'e2e-canned ';

const url = (path: string) => `${API_BASE_PATH}${path}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  agent: request.Agent;
  token: string;
}

interface CannedReplyBody {
  id: string;
  title: string;
  text: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

const DTO_KEYS = [
  'createdAt',
  'id',
  'sortOrder',
  'text',
  'title',
  'updatedAt',
].sort();

describe('Canned replies (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};
  const as = (email: string) => sessions[email];

  /** Every row in the table before this file touched it — all columns. */
  let snapshot: CannedReply[] = [];
  let snapshotIds = new Set<string>();
  /** Every id this file created (API or Prisma). Deleted BY ID at the end. */
  const created: string[] = [];
  /** Every snapshotted row this file deleted, with its original columns. Re-created BY ID at the end. */
  const removed: CannedReply[] = [];

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

  const all = () => prisma.cannedReply.findMany({ orderBy: { id: 'asc' } });
  const count = () => prisma.cannedReply.count();

  /** POST as `email`; a 201's id is tracked BEFORE any assertion can fail. */
  const post = async (email: string, body: unknown) => {
    const res = await as(email)
      .agent.post(url('/canned-replies'))
      .set('x-csrf-token', as(email).token)
      .send(body as object);
    if (res.status === 201) created.push((res.body as CannedReplyBody).id);
    return res;
  };

  const patch = (email: string, id: string, body: unknown) =>
    as(email)
      .agent.patch(url(`/canned-replies/${id}`))
      .set('x-csrf-token', as(email).token)
      .send(body as object);

  const del = (email: string, id: string) =>
    as(email)
      .agent.delete(url(`/canned-replies/${id}`))
      .set('x-csrf-token', as(email).token);

  let seq = 0;
  /** A direct Prisma insert (bypasses the cap on purpose — fixtures only). Tracked. */
  const insertOwn = async (
    over: Partial<
      Pick<CannedReply, 'id' | 'sortOrder' | 'createdAt' | 'updatedAt'>
    > = {},
  ): Promise<CannedReply> => {
    seq += 1;
    const row = await prisma.cannedReply.create({
      data: {
        title: `${OWN}own ${seq}`,
        text: `e2e text ${seq}`,
        sortOrder: 50,
        ...over,
      },
    });
    created.push(row.id);
    return row;
  };

  /**
   * Brings the table to exactly `n` rows (D-7): too few → insert own rows; too many → delete OWN rows
   * first, then snapshotted rows one at a time (last in display order first), remembering each.
   */
  const setCount = async (n: number): Promise<void> => {
    const rows = await prisma.cannedReply.findMany({
      orderBy: [{ sortOrder: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    for (let i = rows.length; i < n; i += 1) await insertOwn();

    let excess = rows.length - n;
    const own = rows.filter((r) => created.includes(r.id));
    const snap = rows.filter((r) => snapshotIds.has(r.id));
    for (const r of [...own, ...snap]) {
      if (excess <= 0) break;
      await prisma.cannedReply.delete({ where: { id: r.id } });
      if (snapshotIds.has(r.id)) removed.push(r);
      excess -= 1;
    }
    expect(await count()).toBe(n);
  };

  /** Idempotent: delete own rows by id, re-create every removed snapshot row by id that is absent. */
  const restore = async (): Promise<void> => {
    if (created.length > 0) {
      await prisma.cannedReply.deleteMany({ where: { id: { in: created } } });
    }
    const present = new Set((await all()).map((r) => r.id));
    const missing = removed.filter((r) => !present.has(r.id));
    if (missing.length > 0) {
      await prisma.cannedReply.createMany({ data: missing });
    }
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);

    // Crash recovery ONLY: a run that died before `afterAll` may have left its own rows behind.
    // Scoped to this file's title prefix — none of the defaults (or any real reply) match it.
    await prisma.cannedReply.deleteMany({
      where: { title: { startsWith: OWN } },
    });
    await purgeE2eUsers(prisma, SU_PREFIX);

    snapshot = await all();
    snapshotIds = new Set(snapshot.map((r) => r.id));

    const options = await ensureE2eOptions(prisma);
    const passwordHash = await new PasswordService().hash(PASSWORD);
    for (const [email, role] of [
      [SUPER, SystemRole.SUPER_ADMIN],
      [ADMIN, SystemRole.ADMIN],
      [VIEWER, SystemRole.VIEWER],
    ] as Array<[string, SystemRole]>) {
      await prisma.systemUser.create({
        data: {
          email,
          firstName: 'E2E',
          lastName: role,
          role,
          passwordHash,
          mustChangePassword: false,
          ...options,
        },
      });
    }
    sessions = {};
    for (const email of [SUPER, ADMIN, VIEWER]) {
      sessions[email] = await login(email);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (prisma) {
        await restore();
        // The AC-19 net — runs even if a test failed half-way.
        expect(await all()).toEqual(snapshot);
      }
    } finally {
      if (prisma) await purgeE2eUsers(prisma, SU_PREFIX);
      if (redis) await clearThrottleCounters(redis);
      if (app) await app.close();
    }
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-12 — the list
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-12 — GET /canned-replies', () => {
    it('a PLAIN array ordered sortOrder → createdAt → id (distinct and tied sortOrders), 200 for all three roles', async () => {
      const T = Date.UTC(2026, 0, 5, 3, 0, 0);
      const early = new Date(T);
      const later = new Date(T + 60_000);
      const oldest = new Date(T - 60_000);
      // Tied sortOrder AND tied createdAt → the id decides (ids chosen to sort identically under any
      // collation). A later createdAt at the same sortOrder goes after them. sortOrder 0 with the
      // oldest createdAt goes before every row at sortOrder 0.
      const late = await insertOwn({
        id: 'e2ecannedorder3',
        sortOrder: 7,
        createdAt: later,
        updatedAt: later,
      });
      const b = await insertOwn({
        id: 'e2ecannedorder2',
        sortOrder: 7,
        createdAt: early,
        updatedAt: early,
      });
      const a = await insertOwn({
        id: 'e2ecannedorder1',
        sortOrder: 7,
        createdAt: early,
        updatedAt: early,
      });
      const first = await insertOwn({
        id: 'e2ecannedorder0',
        sortOrder: 0,
        createdAt: oldest,
        updatedAt: oldest,
      });
      const ownIds = [first.id, a.id, b.id, late.id];

      for (const email of [SUPER, ADMIN, VIEWER]) {
        const res = await as(email)
          .agent.get(url('/canned-replies'))
          .expect(200);
        expect(Array.isArray(res.body)).toBe(true); // not `{ data }`
        const body = res.body as CannedReplyBody[];
        const ids = body.map((r) => r.id);

        expect(ids.filter((id) => ownIds.includes(id))).toEqual(ownIds);
        // Every row honours the order (a stable sort on sortOrder, createdAt keeps the server's order
        // exactly when the server ordered correctly).
        const resorted = [...body].sort(
          (x, y) =>
            x.sortOrder - y.sortOrder || x.createdAt.localeCompare(y.createdAt),
        );
        expect(ids).toEqual(resorted.map((r) => r.id));
        expect(body).toHaveLength(await count());
        for (const r of body) expect(Object.keys(r).sort()).toEqual(DTO_KEYS);
      }

      const one = (
        (await as(VIEWER).agent.get(url('/canned-replies')))
          .body as CannedReplyBody[]
      ).find((r) => r.id === first.id);
      expect(one).toEqual({
        id: first.id,
        title: first.title,
        text: first.text,
        sortOrder: 0,
        createdAt: oldest.toISOString(),
        updatedAt: oldest.toISOString(),
      });
    });

    it('no session → 401', async () => {
      await request(server()).get(url('/canned-replies')).expect(401);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-13 — create: validation and defaults
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-13 — POST /canned-replies', () => {
    beforeAll(async () => {
      await setCount(3);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a missing title', { text: 'x' }],
      ['an empty title', { title: '', text: 'x' }],
      ['a whitespace-only title', { title: '   ', text: 'x' }],
      [
        'a 101-character title',
        { title: `${OWN}${'ก'.repeat(90)}`, text: 'x' },
      ],
      ['an empty text', { title: `${OWN}bad`, text: '' }],
      ['a 1001-character text', { title: `${OWN}bad`, text: 'ข'.repeat(1001) }],
      ['sortOrder -1', { title: `${OWN}bad`, text: 'x', sortOrder: -1 }],
      ['sortOrder 10000', { title: `${OWN}bad`, text: 'x', sortOrder: 10000 }],
      ['sortOrder "3"', { title: `${OWN}bad`, text: 'x', sortOrder: '3' }],
      ['sortOrder 1.5', { title: `${OWN}bad`, text: 'x', sortOrder: 1.5 }],
      ['an unknown key', { title: `${OWN}bad`, text: 'x', foo: 1 }],
    ])(
      '%s → 400 (house body, string[] message, no code), nothing written',
      async (_label, body) => {
        const before = await count();
        const res = await post(ADMIN, body);
        expect(res.status).toBe(400);
        const err = res.body as { message: unknown; code?: string };
        expect(Array.isArray(err.message)).toBe(true);
        expect(err).not.toHaveProperty('code');
        expect(await count()).toBe(before);
      },
    );

    it('a valid POST → 201 with the 6-key DTO, trimmed values, the given sortOrder; the DB agrees', async () => {
      const res = await post(ADMIN, {
        title: `  ${OWN}valid  `,
        text: '  ข้อความทดสอบ  ',
        sortOrder: 42,
      });
      expect(res.status).toBe(201);
      const body = res.body as CannedReplyBody;
      expect(Object.keys(body).sort()).toEqual(DTO_KEYS);
      expect(body).toMatchObject({
        title: `${OWN}valid`,
        text: 'ข้อความทดสอบ',
        sortOrder: 42,
      });
      const row = await prisma.cannedReply.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row.createdAt.toISOString()).toBe(body.createdAt);
      expect(row.updatedAt.toISOString()).toBe(body.updatedAt);
      expect(await count()).toBe(4);
    });

    it('an omitted sortOrder → max(sortOrder) + 1 of the current rows (the bottom of the list)', async () => {
      const { _max } = await prisma.cannedReply.aggregate({
        _max: { sortOrder: true },
      });
      const expected =
        _max.sortOrder === null ? 0 : Math.min(_max.sortOrder + 1, 9999);
      const res = await post(SUPER, { title: `${OWN}bottom`, text: 'x' });
      expect(res.status).toBe(201);
      expect((res.body as CannedReplyBody).sortOrder).toBe(expected);
      expect(expected).toBeGreaterThanOrEqual(43); // the previous test wrote 42
      expect(await count()).toBe(5);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-14 / AC-15 — the cap
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-14 / AC-15 — at most 5', () => {
    it('AC-14 at 5 rows → 400 with EXACTLY the coded body, nothing written', async () => {
      await setCount(5);
      const res = await post(ADMIN, { title: `${OWN}sixth`, text: 'x' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'ข้อความตอบกลับด่วนสามารถมีได้สูงสุดไม่เกิน 5 ข้อความ',
        code: 'CANNED_REPLIES_LIMIT_EXCEEDED',
      });
      expect(CANNED_REPLIES_LIMIT_EXCEEDED).toBe(
        (res.body as { message: string }).message,
      );
      expect(await count()).toBe(5);
      expect(
        await prisma.cannedReply.count({ where: { title: `${OWN}sixth` } }),
      ).toBe(0);
    });

    it.each([1, 2, 3])(
      'AC-15 round %i: at exactly 4 rows, two concurrent POSTs → exactly one 201 and one 400; the table holds 5, never 6',
      async (round) => {
        await setCount(4);
        const [r1, r2] = await Promise.all([
          post(ADMIN, { title: `${OWN}race ${round} a`, text: 'x' }),
          post(SUPER, { title: `${OWN}race ${round} b`, text: 'x' }),
        ]);
        expect([r1.status, r2.status].sort()).toEqual([201, 400]);
        const loser = (r1.status === 400 ? r1 : r2).body as { code?: string };
        expect(loser.code).toBe('CANNED_REPLIES_LIMIT_EXCEEDED');
        expect(await count()).toBe(5);
      },
    );
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-16 — edit and delete (own rows only)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-16 — PATCH / DELETE', () => {
    let own: CannedReply;

    beforeAll(async () => {
      await setCount(4);
      own = await insertOwn({ sortOrder: 60 });
    });

    it('PATCH { title } → 200, trimmed, other fields kept, updatedAt advanced; the DB agrees', async () => {
      await sleep(15);
      const res = await patch(ADMIN, own.id, {
        title: `  ${OWN}renamed  `,
      }).expect(200);
      const body = res.body as CannedReplyBody;
      expect(body).toMatchObject({
        id: own.id,
        title: `${OWN}renamed`,
        text: own.text,
        sortOrder: 60,
        createdAt: own.createdAt.toISOString(),
      });
      expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(
        own.updatedAt.getTime(),
      );
      const row = await prisma.cannedReply.findUniqueOrThrow({
        where: { id: own.id },
      });
      expect(row.title).toBe(`${OWN}renamed`);
      expect(row.updatedAt.toISOString()).toBe(body.updatedAt);
    });

    it('PATCH { text, sortOrder } → 200 (SUPER_ADMIN too)', async () => {
      const res = await patch(SUPER, own.id, {
        text: ' ใหม่ ',
        sortOrder: 0,
      }).expect(200);
      expect(res.body).toMatchObject({ text: 'ใหม่', sortOrder: 0 });
    });

    it('PATCH {} → 400 with EXACTLY the coded body; { title: null } → 400 house body; row unchanged', async () => {
      const before = await prisma.cannedReply.findUniqueOrThrow({
        where: { id: own.id },
      });
      const empty = await patch(ADMIN, own.id, {}).expect(400);
      expect(empty.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: CANNED_REPLY_UPDATE_EMPTY,
        code: 'CANNED_REPLY_UPDATE_EMPTY',
      });
      const nul = await patch(ADMIN, own.id, { title: null }).expect(400);
      expect(nul.body).not.toHaveProperty('code');
      await patch(ADMIN, own.id, { sortOrder: '3' }).expect(400);
      await patch(ADMIN, own.id, { foo: 1 }).expect(400);
      expect(
        await prisma.cannedReply.findUniqueOrThrow({ where: { id: own.id } }),
      ).toEqual(before);
    });

    it('PATCH an unknown id → 404 with EXACTLY the coded body', async () => {
      const res = await patch(ADMIN, 'cnotarealcannedreply000000', {
        title: `${OWN}ghost`,
      }).expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: CANNED_REPLY_NOT_FOUND,
        code: 'CANNED_REPLY_NOT_FOUND',
      });
    });

    it('DELETE → 204 with an empty body; the row is GONE (hard delete); a second DELETE → coded 404', async () => {
      const before = await count();
      const res = await del(ADMIN, own.id).expect(204);
      expect(res.text).toBe('');
      expect(
        await prisma.cannedReply.findUnique({ where: { id: own.id } }),
      ).toBeNull();
      expect(await count()).toBe(before - 1);

      const again = await del(SUPER, own.id).expect(404);
      expect(again.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: CANNED_REPLY_NOT_FOUND,
        code: 'CANNED_REPLY_NOT_FOUND',
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-17 — RBAC, CSRF and session
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-17 — RBAC / CSRF / session', () => {
    let own: CannedReply;

    beforeAll(async () => {
      await setCount(3);
      own = await insertOwn();
    });

    it('VIEWER with a valid CSRF token → 403 on POST, PATCH and DELETE; the table is unchanged', async () => {
      const before = await all();
      const created403 = await post(VIEWER, {
        title: `${OWN}viewer`,
        text: 'x',
      });
      expect(created403.status).toBe(403);
      await patch(VIEWER, own.id, { title: `${OWN}viewer edit` }).expect(403);
      await del(VIEWER, own.id).expect(403);
      expect(await all()).toEqual(before);
    });

    it('ADMIN without x-csrf-token → 403 on all three writes; the table is unchanged', async () => {
      const before = await all();
      const agent = as(ADMIN).agent;
      const res = await agent
        .post(url('/canned-replies'))
        .send({ title: `${OWN}nocsrf`, text: 'x' })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        INVALID_CSRF_TOKEN,
      );
      await agent
        .patch(url(`/canned-replies/${own.id}`))
        .send({ title: 'x' })
        .expect(403);
      await agent.delete(url(`/canned-replies/${own.id}`)).expect(403);
      expect(await all()).toEqual(before);
    });

    it('no session but a minted CSRF token → 401 on all three writes; no session AND no token → 403', async () => {
      const before = await all();
      const agent = request.agent(server());
      const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
      const token = (csrf.body as { csrfToken: string }).csrfToken;
      await agent
        .post(url('/canned-replies'))
        .set('x-csrf-token', token)
        .send({ title: `${OWN}anon`, text: 'x' })
        .expect(401);
      await agent
        .patch(url(`/canned-replies/${own.id}`))
        .set('x-csrf-token', token)
        .send({ title: 'x' })
        .expect(401);
      await agent
        .delete(url(`/canned-replies/${own.id}`))
        .set('x-csrf-token', token)
        .expect(401);
      await request(server())
        .post(url('/canned-replies'))
        .send({ title: `${OWN}bare`, text: 'x' })
        .expect(403);
      expect(await all()).toEqual(before);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-18 — the OpenAPI contract
  // ────────────────────────────────────────────────────────────────────────────────────────────
  describe('AC-18 — /docs-json', () => {
    type Operation = {
      responses: Record<string, unknown>;
      tags?: string[];
      requestBody?: unknown;
    };
    type Schema = {
      enum?: string[];
      properties?: Record<string, unknown>;
    };
    type Doc = {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, Schema> };
    };
    let doc: Doc;

    beforeAll(() => {
      // `createE2eApp` does not mount Swagger (main.ts does), so build the same document here.
      doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      ) as unknown as Doc;
    });

    it('documents the four operations, tagged `Canned replies`, with their statuses', () => {
      const collection = doc.paths[`${API_BASE_PATH}/canned-replies`];
      const item = doc.paths[`${API_BASE_PATH}/canned-replies/{id}`];
      expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
      expect(Object.keys(item).sort()).toEqual(['delete', 'patch']);

      const codes = (op: Operation) => Object.keys(op.responses);
      expect(codes(collection.get)).toEqual(
        expect.arrayContaining(['200', '401', '403']),
      );
      expect(codes(collection.post)).toEqual(
        expect.arrayContaining(['201', '400', '401', '403']),
      );
      expect(codes(item.patch)).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404']),
      );
      expect(codes(item.delete)).toEqual(
        expect.arrayContaining(['204', '401', '403', '404']),
      );
      for (const op of [
        collection.get,
        collection.post,
        item.patch,
        item.delete,
      ]) {
        expect(op.tags).toEqual(['Canned replies']);
      }

      const ref = (op: Operation, status: string) =>
        JSON.stringify(op.responses[status]);
      expect(ref(collection.get, '200')).toContain('"type":"array"');
      expect(ref(collection.get, '200')).toContain('CannedReplyDto');
      expect(ref(collection.post, '201')).toContain('CannedReplyDto');
      expect(ref(item.patch, '200')).toContain('CannedReplyDto');
      expect(ref(collection.post, '400')).toContain('CannedReplyCodedErrorDto');
      expect(ref(item.patch, '400')).toContain('CannedReplyCodedErrorDto');
      expect(ref(item.patch, '404')).toContain('CannedReplyCodedErrorDto');
      expect(ref(item.delete, '404')).toContain('CannedReplyCodedErrorDto');
      expect(JSON.stringify(collection.post.requestBody)).toContain(
        'CreateCannedReplyDto',
      );
      expect(JSON.stringify(item.patch.requestBody)).toContain(
        'UpdateCannedReplyDto',
      );
    });

    it('publishes CannedReplyDto (6 properties), CannedReplyCodedErrorDto and the 3-value CannedReplyErrorCode', () => {
      const s = doc.components.schemas;
      expect(Object.keys(s.CannedReplyDto.properties ?? {}).sort()).toEqual(
        DTO_KEYS,
      );
      expect(
        Object.keys(s.CannedReplyCodedErrorDto.properties ?? {}).sort(),
      ).toEqual(['code', 'error', 'message', 'statusCode']);
      expect(s.CannedReplyErrorCode?.enum).toEqual([
        'CANNED_REPLIES_LIMIT_EXCEEDED',
        'CANNED_REPLY_NOT_FOUND',
        'CANNED_REPLY_UPDATE_EMPTY',
      ]);
      expect(s.CannedReplyErrorCode?.enum).toEqual([
        ...CANNED_REPLY_ERROR_CODES,
      ]);
      expect(
        Object.keys(s.CreateCannedReplyDto.properties ?? {}).sort(),
      ).toEqual(['sortOrder', 'text', 'title']);
      expect(
        Object.keys(s.UpdateCannedReplyDto.properties ?? {}).sort(),
      ).toEqual(['sortOrder', 'text', 'title']);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // AC-19 — LAST: the table is exactly what it was
  // ────────────────────────────────────────────────────────────────────────────────────────────
  it('AC-19 — own rows deleted by id, removed rows re-created by id: the table equals its pre-run snapshot, column for column', async () => {
    await restore();
    const after = await all();
    expect(after).toEqual(snapshot);
    expect(after.map((r) => r.id)).toEqual(snapshot.map((r) => r.id));
    expect(
      await prisma.cannedReply.count({ where: { title: { startsWith: OWN } } }),
    ).toBe(0);
  });
});
