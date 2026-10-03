/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment --
   supertest bodies are untyped JSON; the assertions below name every field they read. */
import { S3Client } from '@aws-sdk/client-s3';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma, SystemRole } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PasswordService } from '../src/auth/password.service';
import { SessionGuard } from '../src/auth/guards/session.guard';
import { API_BASE_PATH } from '../src/common/api.constants';
import { IncidentRecorder } from '../src/incidents/incident-recorder.service';
import { IncidentStore } from '../src/incidents/incident-store';
import {
  IncidentCallerKind,
  IncidentComponent,
  IncidentSeverity,
  type IncidentDraftRecord,
} from '../src/incidents/incident.types';
import { LineService } from '../src/line/line.service';
import { LINE_MESSAGING_CLIENT } from '../src/line/line-messaging-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { addDays, bangkokDate } from '../src/reports/report-calendar';
import { R2StorageService } from '../src/storage/r2-storage.service';
import {
  clearThrottleCounters,
  ensureE2eOptions,
  prismaOf,
  purgeE2eUsers,
  redisOf,
  waitForRedis,
} from './e2e-app';

jest.setTimeout(180_000);

/**
 * Reports Phase 3, Hub 6 (บันทึกข้อผิดพลาด): AC-D1 to AC-D6, the backend side of AC-D10/AC-D11.
 *
 * Redis: every incident key lives under `eb:test:` (`incidentKeyRootFor('test')`), so this suite never
 * reads or writes the dev server's `eb:incident:*`. It clears `eb:test:*` before and after.
 * The DB is touched only for fixture staff users (prefix `e2e-rpt3e-`, purged by prefix).
 */

const PREFIX = 'e2e-rpt3e-';
const PASSWORD = 'E2e-correct-horse-battery-1';
const SA = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;
const url = (path: string) => `${API_BASE_PATH}${path}`;
const DAY = 86_400_000;

const lineClient = {
  pushMessage: jest.fn(),
  multicast: jest.fn(),
};

const r2Values: Record<string, string> = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'e2e-bucket',
  R2_PUBLIC_BASE_URL: 'https://cdn.example.com',
};
const r2Config = {
  get: (k: string) => r2Values[k],
  getOrThrow: (k: string) => r2Values[k],
} as unknown as ConfigService;

/** Test-only routes that force each failure the AC-D3 table lists. Never part of the product. */
@Controller('__fault')
class FaultController {
  constructor(private readonly moduleRef: ModuleRef) {}

  @Get('error')
  error(): never {
    throw new Error('forced api error');
  }

  @Get('staff-error')
  @UseGuards(SessionGuard)
  staffError(): never {
    throw new Error('forced staff error');
  }

  @Get('p2034')
  p2034(): never {
    throw new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: '7.8.0',
    });
  }

  @Get('p1001')
  p1001(): never {
    throw new Prisma.PrismaClientKnownRequestError(
      "Can't reach database server",
      {
        code: 'P1001',
        clientVersion: '7.8.0',
      },
    );
  }

  @Get('leaky')
  leaky(): never {
    throw new Error(
      'failed for U4af4980629a1b2c3d4e5f60718293a4b mail somchai@school.ac.th phone 081-234-5678',
    );
  }

  @Get('r2-put')
  async r2Put(): Promise<never> {
    const r2 = this.moduleRef.get(R2StorageService, { strict: false });
    await r2.putImage(
      'avatars/u1/secretkey.png',
      Buffer.from('x'),
      'image/png',
    );
    throw new Error('unreachable');
  }

  @Get('line-handled')
  async lineHandled(): Promise<{ ok: true }> {
    const line = this.moduleRef.get(LineService, { strict: false });
    try {
      await line.push('Uabc', [{ type: 'text', text: 'x' }]);
    } catch {
      // handled: the request still succeeds
    }
    return { ok: true };
  }

  @Get('bad')
  bad(): never {
    throw new BadRequestException('user mistake');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('nope');
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('nothing here');
  }
}

async function boot(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [FaultController],
  })
    .overrideProvider(LINE_MESSAGING_CLIENT)
    .useValue(lineClient)
    .overrideProvider(R2StorageService)
    .useFactory({
      factory: (recorder: IncidentRecorder) =>
        new R2StorageService(r2Config, recorder),
      inject: [IncidentRecorder],
    })
    .compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  configureApp(app);
  await app.init();
  return app;
}

async function scanDel(redis: Redis, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await wait(50);
  }
}

interface Session {
  agent: request.Agent;
  token: string;
}

const seedRecord = (
  over: Partial<IncidentDraftRecord> = {},
): IncidentDraftRecord => ({
  traceId: 'tr-seed000000000001',
  atMs: Date.now(),
  severity: IncidentSeverity.ERROR,
  component: IncidentComponent.API,
  status: 500,
  method: 'GET',
  routeTemplate: '/api/v1/seed',
  path: '/api/v1/seed',
  queryKeys: [],
  errorCode: 'Error',
  message: 'seeded',
  stack: 'Error: seeded\n    at seed (/srv/seed.js:1:1)',
  caller: { kind: IncidentCallerKind.ANONYMOUS, label: 'anonymous' },
  ip: null,
  userAgent: null,
  context: {},
  ...over,
});

describe('Reports Hub 6 error log (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};
  let anon: Session;

  const server = () => app.getHttpServer();
  const rangeQs = () => {
    const today = bangkokDate(new Date());
    return `startDate=${addDays(today, -2)}&endDate=${today}`;
  };
  const listOf = async (extra = '') => {
    const res = await sessions[SA].agent
      .get(url(`/reports/error-log?${rangeQs()}&limit=50${extra}`))
      .expect(200);
    return res.body as {
      total: number;
      items: Array<{
        id: string;
        traceId: string;
        severity: string;
        component: string;
        status: number | null;
        method: string | null;
        routeTemplate: string | null;
        path: string | null;
        message: string;
        caller: { kind: string; label: string };
      }>;
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

  const seedUsers = async () => {
    await purgeE2eUsers(prisma, PREFIX);
    const options = await ensureE2eOptions(prisma);
    const passwordHash = await new PasswordService().hash(PASSWORD);
    for (const [email, role] of [
      [SA, SystemRole.SUPER_ADMIN],
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
  };

  const startApp = async () => {
    app = await boot();
    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
  };

  const loginAll = async () => {
    sessions = {};
    for (const email of [SA, ADMIN, VIEWER])
      sessions[email] = await login(email);
    const agent = request.agent(server());
    const csrf = await agent.get(url('/auth/system/csrf')).expect(200);
    anon = { agent, token: (csrf.body as { csrfToken: string }).csrfToken };
  };

  beforeAll(async () => {
    await startApp();
    await scanDel(redis, 'eb:test:*');
    await seedUsers();
    await loginAll();
  });

  beforeEach(() => {
    lineClient.pushMessage.mockReset();
    lineClient.multicast.mockReset();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await scanDel(redis, 'eb:test:*');
    await purgeE2eUsers(prisma, PREFIX);
    await app.close();
  });

  // ── AC-D1 / AC-D11 (API half): the role matrix, including path spellings ───────────────────────
  describe('AC-D1 role matrix', () => {
    const q = () => rangeQs();
    const getPaths = () => [
      `/reports/error-log?${q()}`,
      `/reports/error-log/kpis?${q()}`,
      `/reports/error-log/csv?${q()}`,
      `/reports/error-log/detail/ERR-500-0001`,
    ];

    it.each([0, 1, 2, 3])(
      'GET route #%i: 401 / ADMIN 403 / VIEWER 403 / SUPER_ADMIN allowed',
      async (i) => {
        const p = url(getPaths()[i]);
        expect((await request(server()).get(p)).status).toBe(401);
        expect((await sessions[ADMIN].agent.get(p)).status).toBe(403);
        expect((await sessions[VIEWER].agent.get(p)).status).toBe(403);
        const sa = await sessions[SA].agent.get(p);
        expect(sa.status).toBe(i === 3 ? 404 : 200); // an unknown id is a coded 404, not a 403
        if (i === 3) {
          expect(sa.body).toMatchObject({
            statusCode: 404,
            code: 'INCIDENT_NOT_FOUND',
          });
        }
      },
    );

    it('DELETE: 401 / ADMIN 403 / VIEWER 403 / SUPER_ADMIN 204', async () => {
      const p = url('/reports/error-log');
      expect(
        (await anon.agent.delete(p).set('x-csrf-token', anon.token)).status,
      ).toBe(401);
      for (const email of [ADMIN, VIEWER]) {
        const s = sessions[email];
        expect(
          (await s.agent.delete(p).set('x-csrf-token', s.token)).status,
        ).toBe(403);
      }
      const sa = sessions[SA];
      expect(
        (await sa.agent.delete(p).set('x-csrf-token', sa.token)).status,
      ).toBe(204);
    });

    it('DELETE without a CSRF token is the existing CSRF refusal, even for SUPER_ADMIN', async () => {
      const res = await sessions[SA].agent.delete(url('/reports/error-log'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: 'Invalid CSRF token.' });
    });

    it.each([
      ['a trailing slash', (p: string) => p.replace('?', '/?')],
      [
        'upper case',
        (p: string) =>
          p
            .toUpperCase()
            .replace('?STARTDATE=', '?startDate=')
            .replace('&ENDDATE=', '&endDate='),
      ],
    ])(
      '%s answers exactly like the canonical path (Express is non-strict and case-insensitive) and never skips @Roles',
      async (_label, mutate) => {
        for (const base of getPaths().slice(0, 3)) {
          const p = url(mutate(base));
          expect((await request(server()).get(p)).status).toBe(401);
          expect((await sessions[ADMIN].agent.get(p)).status).toBe(403);
          expect((await sessions[VIEWER].agent.get(p)).status).toBe(403);
          expect((await sessions[SA].agent.get(p)).status).toBe(200);
        }
      },
    );

    it('a doubled slash or an encoded slash matches no route: 404 for every role, never data', async () => {
      const variants = [
        `/reports/error-log//?${q()}`,
        `//reports/error-log?${q()}`,
        `/reports//error-log?${q()}`,
        `/reports/error-log%2F?${q()}`,
        `/reports/error%2Dlog?${q()}`,
      ];
      for (const v of variants) {
        const p = url(v).replace('/api/v1//', '/api/v1//');
        for (const agent of [
          request(server()),
          sessions[ADMIN].agent,
          sessions[VIEWER].agent,
          sessions[SA].agent,
        ]) {
          const res = await (
            agent as unknown as {
              get: (u: string) => Promise<request.Response>;
            }
          ).get(p);
          expect(res.status).toBe(404);
          expect(res.body).not.toHaveProperty('items');
        }
      }
    });

    it('csv and kpis are never captured as an incident id, and a bare id is not a route', async () => {
      expect(
        (await sessions[SA].agent.get(url('/reports/error-log/ERR-500-0001')))
          .status,
      ).toBe(404);
      const csv = await sessions[SA].agent.get(
        url(`/reports/error-log/csv?${q()}`),
      );
      expect(csv.headers['content-type']).toContain('text/csv');
    });

    it('rejects an unknown or malformed query key with a pipe 400 (no code) and bad ranges with the P1 codes', async () => {
      const a = sessions[SA].agent;
      expect(
        (await a.get(url(`/reports/error-log?${q()}&bogus=1`))).status,
      ).toBe(400);
      expect(
        (await a.get(url(`/reports/error-log?${q()}&limit=7`))).status,
      ).toBe(400);
      const inv = await a.get(
        url('/reports/error-log?startDate=2026-10-03&endDate=2026-09-01'),
      );
      expect(inv.body).toMatchObject({ code: 'REPORT_RANGE_INVERTED' });
      const wide = await a.get(
        url('/reports/error-log/kpis?startDate=2025-01-01&endDate=2026-10-03'),
      );
      expect(wide.body).toMatchObject({ code: 'REPORT_RANGE_TOO_WIDE' });
      const bad = await a.get(
        url('/reports/error-log/csv?startDate=nope&endDate=2026-10-03'),
      );
      expect(bad.body).toMatchObject({ code: 'REPORT_DATE_INVALID' });
    });
  });

  // ── AC-D2: the trace id ─────────────────────────────────────────────────────────────────────────
  describe('AC-D2 X-Request-Id', () => {
    it('is on every response: success, 400, 401, 403, 404 and 500', async () => {
      const responses = await Promise.all([
        request(server()).get(url('/health')),
        request(server()).get(url('/__fault/bad')),
        request(server()).get(url('/reports/error-log')),
        sessions[ADMIN].agent.get(url('/reports/error-log')),
        request(server()).get(url('/__fault/missing')),
        request(server()).get(url('/__fault/error')),
        request(server()).options(url('/health')),
      ]);
      for (const r of responses) {
        expect(r.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      }
      expect(
        new Set(responses.map((r) => r.headers['x-request-id'])).size,
      ).toBe(responses.length);
    });

    it('echoes a valid inbound id and replaces an invalid one', async () => {
      const ok = await request(server())
        .get(url('/health'))
        .set('X-Request-Id', 'client-trace-0001');
      expect(ok.headers['x-request-id']).toBe('client-trace-0001');
      for (const bad of [
        'short',
        'a'.repeat(65),
        'has space in it!',
        'bad<id>1234567',
      ]) {
        const r = await request(server())
          .get(url('/health'))
          .set('X-Request-Id', bad);
        expect(r.headers['x-request-id']).not.toBe(bad);
        expect(r.headers['x-request-id']).toMatch(/^tr-[0-9a-f]{16}$/);
      }
    });

    it('the incident of a forced 500 carries the SAME id as that response header', async () => {
      const res = await request(server())
        .get(url('/__fault/error'))
        .set('X-Request-Id', 'trace-match-0042');
      expect(res.status).toBe(500);
      const hit = await waitFor(
        async () => (await listOf('&q=trace-match-0042')).items[0],
      );
      expect(hit.traceId).toBe('trace-match-0042');
      expect(res.headers['x-request-id']).toBe(hit.traceId);
      // Searching a full trace id returns exactly its incident(s).
      expect((await listOf('&q=trace-match-0042')).total).toBe(1);
    });
  });

  // ── AC-D3: capture ──────────────────────────────────────────────────────────────────────────────
  describe('AC-D3 capture', () => {
    const only = async (traceId: string) => {
      const hit = await waitFor(async () => {
        const r = await listOf(`&q=${traceId}`);
        return r.items.length > 0 ? r : null;
      });
      expect(hit.items).toHaveLength(1);
      return hit.items[0];
    };

    it.each([
      ['/__fault/error', 500, IncidentSeverity.ERROR, IncidentComponent.API],
      [
        '/__fault/p2034',
        500,
        IncidentSeverity.CRITICAL,
        IncidentComponent.PRISMA_DB,
      ],
      [
        '/__fault/p1001',
        500,
        IncidentSeverity.CRITICAL,
        IncidentComponent.PRISMA_DB,
      ],
    ])(
      '%s -> %i %s %s, with method and route template',
      async (path, status, severity, component) => {
        const id = `trace-${path.replace('/__fault/', '')}-capture`;
        const res = await request(server())
          .get(url(path))
          .set('X-Request-Id', id);
        expect(res.status).toBe(status);
        const inc = await only(id);
        expect(inc).toMatchObject({
          severity,
          component,
          status,
          method: 'GET',
          routeTemplate: `/api/v1${path}`,
          path: `/api/v1${path}`,
        });
      },
    );

    it('a LINE push failure with no HTTP request (a worker) is ERROR LINE_OA with a system caller', async () => {
      lineClient.pushMessage.mockRejectedValue(
        Object.assign(new Error('503'), {
          name: 'HTTPFetchError',
          status: 503,
        }),
      );
      const before = (await listOf()).total;
      await app
        .get(LineService)
        .push('Uworker', [{ type: 'text', text: 'x' }])
        .catch(() => undefined);
      const list = await waitFor(async () => {
        const l = await listOf('&component=LINE_OA');
        return l.total > 0 ? l : null;
      });
      expect(list.items[0]).toMatchObject({
        severity: 'ERROR',
        component: 'LINE_OA',
        status: null,
        method: null,
        routeTemplate: null,
      });
      expect(list.items[0].caller.kind).toBe('SYSTEM');
      expect(list.items[0].caller.label).toBe('system (LINE OA push)');
      expect((await listOf()).total).toBeGreaterThan(before);
    });

    it('a LINE call over its budget but delivered is a WARNING (and the call still resolves)', async () => {
      lineClient.pushMessage.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ sent: true }), 3200),
          ),
      );
      await expect(
        app.get(LineService).push('Uslow', [{ type: 'text', text: 'x' }]),
      ).resolves.toEqual({ sent: true });
      const list = await waitFor(async () => {
        const l = await listOf('&severity=WARNING&component=LINE_OA');
        return l.total > 0 ? l : null;
      });
      expect(list.items[0].message).toMatch(
        /push took \d+ ms \(budget 3000 ms\)/,
      );
    });

    it('a LINE failure inside a request that still answers 200 is recorded against that request, status 200', async () => {
      lineClient.pushMessage.mockRejectedValue(
        Object.assign(new Error('boom'), {
          name: 'HTTPFetchError',
          status: 500,
        }),
      );
      const id = 'trace-line-inreq-0001';
      const res = await request(server())
        .get(url('/__fault/line-handled'))
        .set('X-Request-Id', id);
      expect(res.status).toBe(200);
      const inc = await only(id);
      expect(inc).toMatchObject({
        component: 'LINE_OA',
        status: 200,
        routeTemplate: '/api/v1/__fault/line-handled',
      });
    });

    it('an R2 put failure is ONE ERROR Cloudflare R2 incident, status 502, with no key in it', async () => {
      jest
        .spyOn(S3Client.prototype, 'send')
        .mockRejectedValue(new Error('AccessDenied') as never);
      const id = 'trace-r2-put-0000001';
      const res = await request(server())
        .get(url('/__fault/r2-put'))
        .set('X-Request-Id', id);
      expect(res.status).toBe(502);
      const inc = await only(id);
      expect(inc).toMatchObject({
        severity: 'ERROR',
        component: 'CLOUDFLARE_R2',
        status: 502,
      });
      const detail = await sessions[SA].agent
        .get(url(`/reports/error-log/detail/${inc.id}`))
        .expect(200);
      expect(detail.body.context).toMatchObject({
        bucket: 'e2e-bucket',
        keyPrefix: 'avatars/',
        operation: 'putImage',
      });
      expect(JSON.stringify(detail.body)).not.toContain('secretkey');
    });

    it('a Redis command failure is ERROR Redis', async () => {
      const client = app.get<Redis>(REDIS_CLIENT);
      const spy = jest
        .spyOn(client, 'get')
        .mockRejectedValue(new Error('Command timed out'));
      await expect(app.get(RedisService).getJson('opt:x')).resolves.toBeNull();
      spy.mockRestore(); // the session store shares this client: listing below needs it back
      const list = await waitFor(async () => {
        const l = await listOf('&component=REDIS');
        return l.total > 0 ? l : null;
      });
      expect(list.items[0]).toMatchObject({
        severity: 'ERROR',
        component: 'REDIS',
      });
    });

    it('a 400, 401, 403 and 404 create NO incident', async () => {
      const before = (await listOf()).total;
      await request(server()).get(url('/__fault/bad')).expect(400);
      await request(server()).get(url('/__fault/forbidden')).expect(403);
      await request(server()).get(url('/__fault/missing')).expect(404);
      await request(server()).get(url('/reports/error-log')).expect(401);
      await request(server()).get(url('/no-such-route')).expect(404);
      await wait(400);
      expect((await listOf()).total).toBe(before);
    });
  });

  // ── The recorder must never change a response ───────────────────────────────────────────────────
  describe("the forced 500 body is Nest's own, with or without a working recorder (AC-D3)", () => {
    const expected = { statusCode: 500, message: 'Internal server error' };

    it('is byte-identical to the default body', async () => {
      const res = await request(server()).get(url('/__fault/error'));
      expect(res.status).toBe(500);
      expect(res.body).toEqual(expected);
      expect(res.text).toBe(JSON.stringify(expected));
    });

    it('is unchanged, and does not loop, when the store throws', async () => {
      const add = jest
        .spyOn(IncidentStore.prototype, 'add')
        .mockRejectedValue(new Error('store down'));
      const res = await request(server()).get(url('/__fault/error'));
      expect(res.status).toBe(500);
      expect(res.text).toBe(JSON.stringify(expected));
      await wait(300);
      expect(add.mock.calls.length).toBeLessThanOrEqual(1); // one attempt, no retry loop
    });

    it('a 4xx body is unchanged too', async () => {
      const res = await request(server()).get(url('/__fault/bad'));
      expect(res.body).toEqual({
        statusCode: 400,
        message: 'user mistake',
        error: 'Bad Request',
      });
    });
  });

  // ── AC-D4: redaction on stored records ──────────────────────────────────────────────────────────
  describe('AC-D4 redaction', () => {
    it('stores no LINE id, e-mail, phone, cookie, token or query value; keeps query keys', async () => {
      const id = 'trace-redact-0000001';
      await request(server())
        .get(url('/__fault/leaky?token=hunter2value&page=2'))
        .set('X-Request-Id', id)
        .set('Cookie', 'eb.sid=session-cookie-secret')
        .set('Authorization', 'Bearer sk-live-authorization-secret')
        .set('x-line-signature', 'signature-secret-value')
        .set('User-Agent', 'jest-agent contact ops@school.ac.th')
        .expect(500);
      const hit = await waitFor(
        async () => (await listOf(`&q=${id}`)).items[0],
      );
      const detail = await sessions[SA].agent
        .get(url(`/reports/error-log/detail/${hit.id}`))
        .expect(200);
      const dump = JSON.stringify(detail.body);
      for (const secret of [
        'U4af4980629a1b2c3d4e5f60718293a4b',
        'somchai@school.ac.th',
        '081-234-5678',
        'session-cookie-secret',
        'authorization-secret',
        'signature-secret-value',
        'hunter2value',
        'ops@school.ac.th',
      ]) {
        expect(dump).not.toContain(secret);
      }
      expect(detail.body.queryKeys).toEqual(['token', 'page']);
      expect(detail.body.message.length).toBeLessThanOrEqual(500);
      expect(detail.body.stack.split('\n').length).toBeLessThanOrEqual(50);
      expect(detail.body.caller).toEqual({
        kind: 'ANONYMOUS',
        label: 'anonymous',
      });
    });

    it('names a staff caller by id and role only, never a name or e-mail', async () => {
      const id = 'trace-staff-caller-001';
      // SessionGuard attaches req.systemUser, which the recorder reads for the caller.
      await sessions[ADMIN].agent
        .get(url('/__fault/staff-error'))
        .set('X-Request-Id', id)
        .expect(500);
      const hit = await waitFor(
        async () => (await listOf(`&q=${id}`)).items[0],
      );
      expect(hit.caller.kind).toBe('STAFF');
      expect(hit.caller.label).toMatch(/^staff:[a-z0-9]+ \(ADMIN\)$/);
    });
  });

  // ── AC-D5: store and retention ──────────────────────────────────────────────────────────────────
  describe('AC-D5 store and retention', () => {
    it('uses the intended Redis keys under the test root, never the cache prefix', async () => {
      await request(server()).get(url('/__fault/error')).expect(500);
      await waitFor(
        async () => (await redis.exists('eb:test:incident:ring')) === 1,
      );
      const keys = (await redis.keys('eb:test:incident:*')).sort();
      expect(keys).toEqual(
        expect.arrayContaining([
          'eb:test:incident:detail',
          'eb:test:incident:ring',
          'eb:test:incident:seq',
        ]),
      );
      expect(await redis.keys('eb:cache:*incident*')).toEqual([]);
      expect(await redis.keys('eb:incident:*')).toEqual(
        expect.not.arrayContaining(['eb:test:incident:ring']),
      );
    });

    it('an incident survives an APP restart', async () => {
      const id = 'trace-restart-000001';
      await request(server())
        .get(url('/__fault/error'))
        .set('X-Request-Id', id)
        .expect(500);
      await waitFor(async () => (await listOf(`&q=${id}`)).total === 1);

      await app.close();
      await startApp();
      await loginAll();
      const after = await listOf(`&q=${id}`);
      expect(after.total).toBe(1);
      expect(after.items[0].traceId).toBe(id);
    });

    it('the cap holds: inserting cap + 10 keeps exactly cap and drops the OLDEST (and their details)', async () => {
      const store = new IncidentStore(redis, 'eb:test:cap:', { cap: 50 });
      const base = Date.now() - 1000;
      const ids: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        ids.push(
          await store.add(seedRecord({ atMs: base + i, message: `m${i}` })),
        );
      }
      const kept = await store.list();
      expect(kept).toHaveLength(50);
      expect(kept.map((r) => r.id)).toEqual(ids.slice(10).reverse());
      expect(await store.detail(ids[0])).toBeNull();
      expect(await store.detail(ids[9])).toBeNull();
      expect((await store.detail(ids[10]))?.message).toBe('m10');
      expect(await redis.hlen(store.detailKey)).toBe(50);
    });

    it('the age cap drops an entry past it, with its detail', async () => {
      const store = new IncidentStore(redis, 'eb:test:age:', { maxAgeDays: 1 });
      const oldId = await store.add(seedRecord({ atMs: Date.now() - 2 * DAY }));
      await store.add(seedRecord({ atMs: Date.now() }));
      expect(await store.detail(oldId)).toBeNull();
      expect(await store.list()).toHaveLength(1);
    });

    it('with Redis not ready, incidents (and the outage itself) are buffered and appear once Redis is back', async () => {
      const recorder = app.get(IncidentRecorder);
      const id = 'trace-buffered-00001';
      const live = redis as unknown as { status: string };
      live.status = 'reconnecting';
      try {
        await request(server())
          .get(url('/__fault/error'))
          .set('X-Request-Id', id)
          .expect(500);
        await wait(200);
        expect(recorder.bufferedCount).toBeGreaterThanOrEqual(1);
      } finally {
        live.status = 'ready';
      }
      expect((await listOf(`&q=${id}`)).total).toBe(0); // not stored yet
      redis.emit('ready');
      const flushed = await waitFor(
        async () => (await listOf(`&q=${id}`)).total === 1,
      );
      expect(flushed).toBe(true);
      expect(recorder.bufferedCount).toBe(0);
    });
  });

  // ── AC-D6 / AC-D8 / AC-D10: KPIs, list, csv, detail, purge ──────────────────────────────────────
  describe('KPIs, list, CSV, detail and purge', () => {
    beforeAll(async () => {
      await scanDel(redis, 'eb:test:*');
    });

    it('availability = 100 x (1 - 5xx/requests) over the range days, with the days lacking data counted', async () => {
      await redis.set('eb:test:metrics:req:20200203', '1000');
      await redis.set('eb:test:metrics:5xx:20200203', '4');
      await redis.set('eb:test:metrics:req:20200204', '500');
      const res = await sessions[SA].agent
        .get(
          url(
            '/reports/error-log/kpis?startDate=2020-02-03&endDate=2020-02-05',
          ),
        )
        .expect(200);
      expect(res.body.kpis.availability).toEqual({
        percent: (1 - 4 / 1500) * 100,
        failed: 4,
        requests: 1500,
        daysWithoutData: 1,
        targetPercent: 99.5,
      });
      expect(res.body.kpis.inRange).toBe(0);
      const none = await sessions[SA].agent
        .get(
          url(
            '/reports/error-log/kpis?startDate=2020-03-03&endDate=2020-03-03',
          ),
        )
        .expect(200);
      expect(none.body.kpis.availability.percent).toBeNull();
    });

    it('last24h is rolling and independent of the range; critical and external counts follow the range', async () => {
      const store = app.get(IncidentStore);
      const now = Date.now();
      await store.add(
        seedRecord({
          atMs: now - 1000,
          severity: IncidentSeverity.CRITICAL,
          component: IncidentComponent.PRISMA_DB,
          message: 'kpi-critical',
        }),
      );
      await store.add(
        seedRecord({
          atMs: now - 2000,
          component: IncidentComponent.LINE_OA,
          message: 'kpi-line',
        }),
      );
      await store.add(
        seedRecord({
          atMs: now - 3000,
          component: IncidentComponent.CLOUDFLARE_R2,
          message: 'kpi-r2',
        }),
      );
      await store.add(
        seedRecord({
          atMs: now - 4000,
          component: IncidentComponent.REDIS,
          message: 'kpi-redis',
        }),
      );
      const res = await sessions[SA].agent
        .get(url(`/reports/error-log/kpis?${rangeQs()}`))
        .expect(200);
      const k = res.body.kpis;
      expect(k.critical.count).toBeGreaterThanOrEqual(1);
      expect(k.external.lineOa).toBeGreaterThanOrEqual(1);
      expect(k.external.cloudflareR2).toBeGreaterThanOrEqual(1);
      expect(k.external.redis).toBeGreaterThanOrEqual(1);
      expect(k.last24h).toBeGreaterThanOrEqual(4);
      const past = await sessions[SA].agent
        .get(
          url(
            '/reports/error-log/kpis?startDate=2020-02-03&endDate=2020-02-04',
          ),
        )
        .expect(200);
      expect(past.body.kpis.inRange).toBe(0);
      expect(past.body.kpis.last24h).toBeGreaterThanOrEqual(4);
    });

    it('filters by severity and component, searches literally (% and _), paginates and clamps', async () => {
      const store = app.get(IncidentStore);
      const now = Date.now();
      for (let i = 0; i < 25; i += 1) {
        await store.add(
          seedRecord({
            atMs: now - 10_000 - i,
            message: `page-fixture ${i}`,
            traceId: `tr-page${String(i).padStart(11, '0')}`,
          }),
        );
      }
      await store.add(
        seedRecord({ atMs: now - 9000, message: '100% literal-percent' }),
      );
      expect((await listOf('&q=literal-percent')).total).toBe(1);
      expect(
        (await listOf('&q=%25')).items.every((r) => r.message.includes('%')),
      ).toBe(true);
      expect(
        (await listOf('&q=_')).items.every(
          (r) =>
            r.message.includes('_') ||
            (r.path ?? '').includes('_') ||
            r.id.includes('_') ||
            r.traceId.includes('_'),
        ),
      ).toBe(true);
      expect(
        (await listOf('&severity=CRITICAL')).items.every(
          (r) => r.severity === 'CRITICAL',
        ),
      ).toBe(true);

      const seen = new Set<string>();
      for (let page = 1; page <= 3; page += 1) {
        const res = await sessions[SA].agent
          .get(
            url(
              `/reports/error-log?${rangeQs()}&q=page-fixture&limit=10&page=${page}`,
            ),
          )
          .expect(200);
        for (const item of res.body.items as Array<{ id: string }>) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        expect(res.body.total).toBe(25);
        expect(res.body.totalPages).toBe(3);
        expect(res.body.items).toHaveLength(page === 3 ? 5 : 10);
      }
      const clamped = await sessions[SA].agent
        .get(
          url(
            `/reports/error-log?${rangeQs()}&q=page-fixture&limit=10&page=99`,
          ),
        )
        .expect(200);
      expect(clamped.body.page).toBe(3);
      expect(clamped.body.retention).toEqual({ maxEntries: 5000, maxDays: 90 });
    });

    it('the CSV holds every filtered row, no stack or context, BOM + CRLF, formulas neutralised', async () => {
      const store = app.get(IncidentStore);
      await store.add(
        seedRecord({
          message: '=HYPERLINK("http://evil","x")',
          traceId: 'tr-csvformula00001',
          stack: 'Error: STACKSECRET\n    at x (/srv/x.js:1:1)',
          context: { bucket: 'CONTEXTSECRET' },
        }),
      );
      const res = await sessions[SA].agent
        .get(url(`/reports/error-log/csv?${rangeQs()}&q=HYPERLINK`))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
        })
        .expect(200);
      const body = res.body as unknown as string;
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="easybook-error-log_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(body.charCodeAt(0)).toBe(0xfeff);
      expect(body).toContain('\r\n');
      expect(body).toContain("'=HYPERLINK");
      expect(body).toContain('(กรองแล้ว)');
      expect(body).not.toContain('STACKSECRET');
      expect(body).not.toContain('CONTEXTSECRET');
      const dataRows = body
        .split('\r\n')
        .filter((l) => l.includes('HYPERLINK'));
      expect(dataRows).toHaveLength(1);
    });

    it('detail returns the stack and context for a known id', async () => {
      const store = app.get(IncidentStore);
      const id = await store.add(
        seedRecord({
          context: { bucket: 'b', attempts: 2 },
          traceId: 'tr-detail0000001',
        }),
      );
      const res = await sessions[SA].agent
        .get(url(`/reports/error-log/detail/${id}`))
        .expect(200);
      expect(res.body).toMatchObject({
        id,
        traceId: 'tr-detail0000001',
        context: { bucket: 'b', attempts: 2 },
      });
      expect(res.body.stack).toContain('seed');
      await sessions[SA].agent
        .get(url('/reports/error-log/detail/ERR-500-9999999'))
        .expect(404);
      await sessions[SA].agent
        .get(url('/reports/error-log/detail/not-an-id'))
        .expect(404);
    });

    it('purge removes only incidents older than the 30 Bangkok-day window, leaves newer ones, and is idempotent', async () => {
      const store = app.get(IncidentStore);
      const now = Date.now();
      const oldA = await store.add(
        seedRecord({ atMs: now - 40 * DAY, message: 'purge-old-a' }),
      );
      const oldB = await store.add(
        seedRecord({ atMs: now - 35 * DAY, message: 'purge-old-b' }),
      );
      const keep = await store.add(
        seedRecord({ atMs: now - 5 * DAY, message: 'purge-keep' }),
      );
      const widest = (extra = '') =>
        `startDate=${addDays(bangkokDate(new Date()), -60)}&endDate=${bangkokDate(new Date())}&limit=50${extra}`;
      const before = await sessions[SA].agent
        .get(url(`/reports/error-log?${widest('&q=purge-')}`))
        .expect(200);
      expect(before.body.total).toBe(3);
      expect(before.body.purgeable.count).toBeGreaterThanOrEqual(2);

      const sa = sessions[SA];
      await sa.agent
        .delete(url('/reports/error-log'))
        .set('x-csrf-token', sa.token)
        .expect(204);
      const after = await sa.agent
        .get(url(`/reports/error-log?${widest('&q=purge-')}`))
        .expect(200);
      expect(
        (after.body.items as Array<{ id: string }>).map((i) => i.id),
      ).toEqual([keep]);
      expect(await store.detail(oldA)).toBeNull();
      expect(await store.detail(oldB)).toBeNull();
      expect(await store.detail(keep)).not.toBeNull();

      await sa.agent
        .delete(url('/reports/error-log'))
        .set('x-csrf-token', sa.token)
        .expect(204);
      const again = await sa.agent
        .get(url(`/reports/error-log?${widest('&q=purge-')}`))
        .expect(200);
      expect(again.body.total).toBe(1);
      expect(again.body.purgeable.count).toBe(0);
    });
  });
});
