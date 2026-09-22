import { createHmac } from 'node:crypto';
import { HTTPFetchError, messagingApi } from '@line/bot-sdk';
import type { INestApplication } from '@nestjs/common';
import { SystemRole, type AppSetting } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PasswordService } from '../src/auth/password.service';
import { API_BASE_PATH } from '../src/common/api.constants';
import { LINE_SETTING_KEYS } from '../src/line/line-credentials.service';
import { LINE_MESSAGING_CLIENT } from '../src/line/line-messaging-client';
import { LineService } from '../src/line/line.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2StorageService } from '../src/storage/r2-storage.service';
import { SWAGGER_SETTING_KEY } from '../src/system/swagger-gate.service';
import { mountSwagger } from '../src/system/swagger.setup';
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
 * `INTEGRATIONS-API-1` — `/api/v1/system/integrations` and the runtime Swagger gate.
 *
 * 🔴 NOTHING HERE MAY REACH LINE OR R2.
 *   · The Messaging client is REPLACED (`LINE_MESSAGING_CLIENT` → `fakeLine`), and `beforeAll` refuses
 *     to run unless `LineService` holds it. `LineCredentialsService` ignores stored credentials under
 *     `NODE_ENV=test` (plan D-4), so a token saved in the dev DB cannot displace the fake — and this
 *     file never saves a token (a valid one would build a real client in-process).
 *   · A `fetch` tripwire rejects every `*.line.me` request and records it; the last test asserts it
 *     recorded nothing.
 *   · `R2StorageService` is replaced by a fake; the probe's S3 path is covered by the unit spec.
 *
 * 🔴 THE DATABASE IS SHARED. The four `AppSetting` keys this surface writes are SNAPSHOTTED in
 * `beforeAll` and put back BY KEY in `afterAll` — a row that did not exist is deleted, a row that did
 * gets its original value back. Users are `e2e-integ-` prefixed and purged.
 */

const PREFIX = 'e2e-integ-';
const PASSWORD = 'E2e-correct-horse-battery-1';
const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;

const KEYS = [SWAGGER_SETTING_KEY, ...Object.values(LINE_SETTING_KEYS)];
const TRIPWIRE = 'e2e tripwire: LINE is unreachable from this suite';

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

const httpError = (status: number) =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{}',
  });

/** The slice of the GET body these tests read — typed so no assertion reads an `any`. */
interface OverviewBody {
  swagger: { enabled: boolean };
  line: {
    configured: boolean;
    channelId: string | null;
    botInfo: Record<string, unknown> | null;
    quota: { total: number | null; used: number } | null;
  };
  storage: Record<string, unknown>;
  infrastructure: {
    database: { status: string; latencyMs: number };
    redis: { status: string; latencyMs: number };
  };
}
const overviewOf = (res: request.Response) => res.body as OverviewBody;
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;

describe('System integrations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redis: Redis;
  let sessions: Record<string, Session> = {};
  let snapshot: AppSetting[] = [];
  const lineHits: string[] = [];
  let realFetch: typeof fetch;

  const fakeLine = {
    getBotInfo: jest.fn(),
    getMessageQuota: jest.fn(),
    getMessageQuotaConsumption: jest.fn(),
    pushMessage: jest.fn(),
    multicast: jest.fn(),
  };
  const storageFake = {
    isConfigured: jest.fn().mockReturnValue(true),
    publicBaseUrl: jest.fn().mockReturnValue('https://pub-e2e.r2.dev'),
    probe: jest
      .fn()
      .mockResolvedValue({ ok: true, latencyMs: 12, read: true, write: true }),
  };

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];

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

  const get = (email: string) =>
    as(email).agent.get(url('/system/integrations'));
  const patch = (email: string, path: string, body: object) =>
    as(email)
      .agent.patch(url(`/system/integrations/${path}`))
      .set('x-csrf-token', as(email).token)
      .send(body);
  const post = (email: string, path: string) =>
    as(email)
      .agent.post(url(`/system/integrations/${path}`))
      .set('x-csrf-token', as(email).token);

  const goodLine = () => {
    fakeLine.getBotInfo.mockResolvedValue({
      userId: 'Ubot',
      basicId: '@easybook_th',
      displayName: 'EasyBook Bot',
      chatMode: 'bot',
      markAsReadMode: 'auto',
    });
    fakeLine.getMessageQuota.mockResolvedValue({ type: 'limited', value: 500 });
    fakeLine.getMessageQuotaConsumption.mockResolvedValue({ totalUsage: 44 });
  };

  const restoreSettings = async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
    if (snapshot.length) await prisma.appSetting.createMany({ data: snapshot });
  };

  beforeAll(async () => {
    // ── Tripwire, before anything can construct a client ──
    realFetch = global.fetch;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const u = new URL(href);
      if (/(^|\.)line\.me$/.test(u.hostname)) {
        lineHits.push(u.pathname);
        return Promise.reject(new Error(TRIPWIRE));
      }
      return realFetch(input, init);
    });
    const proof = await new messagingApi.MessagingApiClient({
      channelAccessToken: 'e2e-bogus-token',
    })
      .getBotInfo()
      .then(
        () => 'resolved',
        (e: Error) => `${e.message} @ ${lineHits.join(',')}`,
      );
    if (proof !== `${TRIPWIRE} @ /v2/bot/info`) {
      throw new Error(
        `The fetch tripwire does not intercept the LINE SDK (${proof}) — refusing to run.`,
      );
    }
    lineHits.length = 0;

    app = await createE2eApp(
      (b) =>
        b
          .overrideProvider(LINE_MESSAGING_CLIENT)
          .useValue(fakeLine)
          .overrideProvider(R2StorageService)
          .useValue(storageFake),
      (a) => mountSwagger(a),
    );
    if (Reflect.get(app.get(LineService), 'client') !== fakeLine) {
      throw new Error(
        'LineService does not hold the fake Messaging client — refusing to run.',
      );
    }

    prisma = prismaOf(app);
    redis = redisOf(app);
    await waitForRedis(redis);
    await clearThrottleCounters(redis);
    await purgeE2eUsers(prisma, PREFIX);

    snapshot = await prisma.appSetting.findMany({
      where: { key: { in: KEYS } },
    });

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
    for (const email of [SUPER, ADMIN, VIEWER])
      sessions[email] = await login(email);
  }, 120_000);

  beforeEach(() => {
    jest.clearAllMocks();
    goodLine();
  });

  afterAll(async () => {
    if (prisma) {
      await restoreSettings();
      await purgeE2eUsers(prisma, PREFIX);
    }
    if (app) await app.close();
    global.fetch = realFetch;
  });

  // ── RBAC ────────────────────────────────────────────────────────────────
  describe('role gating', () => {
    it('GET: SUPER_ADMIN 200, ADMIN 200, VIEWER 403, no session 401', async () => {
      await get(SUPER).expect(200);
      await get(ADMIN).expect(200);
      await get(VIEWER).expect(403);
      await request(server()).get(url('/system/integrations')).expect(401);
    });

    it('PATCH /swagger and /line: ADMIN 403, VIEWER 403, and nothing is written', async () => {
      const before = await prisma.appSetting.findMany({
        where: { key: { in: KEYS } },
      });
      for (const who of [ADMIN, VIEWER]) {
        await patch(who, 'swagger', { enabled: true }).expect(403);
        await patch(who, 'line', { channelId: '2006123442' }).expect(403);
      }
      expect(
        await prisma.appSetting.findMany({ where: { key: { in: KEYS } } }),
      ).toEqual(before);
    });

    it('a write with no session and no CSRF token is 403 (CSRF runs first)', async () => {
      await request(server())
        .patch(url('/system/integrations/swagger'))
        .send({ enabled: true })
        .expect(403);
    });

    it('POST probes: SUPER_ADMIN and ADMIN 200, VIEWER 403', async () => {
      for (const who of [SUPER, ADMIN]) {
        await post(who, 'line/verify').expect(200);
        await post(who, 'storage/probe').expect(200);
      }
      await post(VIEWER, 'line/verify').expect(403);
      await post(VIEWER, 'storage/probe').expect(403);
    });
  });

  // ── GET ─────────────────────────────────────────────────────────────────
  describe('GET /system/integrations', () => {
    it('answers the documented shape and never a secret or token', async () => {
      const res = await get(ADMIN).expect(200);
      const body = overviewOf(res);
      expect(Object.keys(body).sort()).toEqual([
        'infrastructure',
        'line',
        'storage',
        'swagger',
      ]);
      expect(typeof body.swagger.enabled).toBe('boolean');
      expect(body.line.configured).toBe(true);
      expect(body.line.botInfo).toEqual({
        basicId: '@easybook_th',
        displayName: 'EasyBook Bot',
        pictureUrl: null,
        chatMode: 'bot',
      });
      expect(body.line.quota).toEqual({ total: 500, used: 44 });
      // `bucket` is whatever `.env` holds (or null) — only its presence is asserted.
      expect(Object.keys(body.storage).sort()).toEqual([
        'bucket',
        'configured',
        'publicBaseUrl',
      ]);
      expect(body.storage.configured).toBe(true);
      expect(body.storage.publicBaseUrl).toBe('https://pub-e2e.r2.dev');
      expect(body.infrastructure.database.status).toMatch(/^(ok|degraded)$/);
      expect(body.infrastructure.redis.status).toBe('up');
      expect(JSON.stringify(body)).not.toMatch(/secret|token/i);
    });

    it('stays 200 when LINE fails (fail-soft) — botInfo and quota go null', async () => {
      fakeLine.getBotInfo.mockRejectedValue(httpError(500));
      fakeLine.getMessageQuota.mockRejectedValue(httpError(500));
      const res = await get(SUPER).expect(200);
      expect(overviewOf(res).line.botInfo).toBeNull();
      expect(overviewOf(res).line.quota).toBeNull();
    });
  });

  // ── Swagger gate ────────────────────────────────────────────────────────
  describe('runtime Swagger gate', () => {
    it('OFF → /docs, /docs-json and a /docs asset answer Nest’s own 404; ON → 200; the row persists', async () => {
      const off = await patch(SUPER, 'swagger', { enabled: false }).expect(200);
      expect(off.body).toEqual({ success: true, enabled: false });
      expect(
        (
          await prisma.appSetting.findUnique({
            where: { key: SWAGGER_SETTING_KEY },
          })
        )?.value,
      ).toBe('false');

      const json404 = await request(server()).get('/docs-json').expect(404);
      expect(json404.body).toEqual({
        message: 'Cannot GET /docs-json',
        error: 'Not Found',
        statusCode: 404,
      });
      await request(server()).get('/docs').expect(404);
      await request(server()).get('/docs/swagger-ui.css').expect(404);
      expect(overviewOf(await get(ADMIN).expect(200)).swagger.enabled).toBe(
        false,
      );

      await patch(SUPER, 'swagger', { enabled: true }).expect(200);
      const spec = await request(server()).get('/docs-json').expect(200);
      expect((spec.body as { openapi: string }).openapi).toMatch(/^3\./);
      expect(
        (spec.body as { paths: Record<string, unknown> }).paths,
      ).toHaveProperty(`${API_BASE_PATH}/system/integrations`);
      expect([200, 301]).toContain(
        (await request(server()).get('/docs')).status,
      );
      expect(overviewOf(await get(ADMIN).expect(200)).swagger.enabled).toBe(
        true,
      );
    });

    it('rejects a non-boolean (the string "true") and an unknown key with 400', async () => {
      await patch(SUPER, 'swagger', { enabled: 'true' }).expect(400);
      await patch(SUPER, 'swagger', { enabled: true, extra: 1 }).expect(400);
    });
  });

  // ── LINE ────────────────────────────────────────────────────────────────
  describe('PATCH /system/integrations/line', () => {
    it('validates: empty body → 400 LINE_UPDATE_EMPTY; bad id / secret / token → 400', async () => {
      const empty = await patch(SUPER, 'line', {}).expect(400);
      expect(codeOf(empty)).toBe('LINE_UPDATE_EMPTY');
      await patch(SUPER, 'line', { channelId: '12345' }).expect(400);
      await patch(SUPER, 'line', { channelId: '' }).expect(400);
      await patch(SUPER, 'line', { channelSecret: 'xyz' }).expect(400);
      await patch(SUPER, 'line', { channelAccessToken: 'short' }).expect(400);
    });

    it('persists, masks, and a new secret verifies the very next webhook — no restart', async () => {
      const secret = 'ab'.repeat(16);
      const res = await patch(SUPER, 'line', {
        channelId: '2006555511',
        channelSecret: secret,
      }).expect(200);
      expect(res.body).toEqual({
        success: true,
        maskedChannelId: '2006••••11',
      });
      expect(JSON.stringify(res.body)).not.toContain(secret);

      const rows = await prisma.appSetting.findMany({
        where: {
          key: {
            in: [LINE_SETTING_KEYS.channelId, LINE_SETTING_KEYS.channelSecret],
          },
        },
      });
      expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
        [LINE_SETTING_KEYS.channelId]: '2006555511',
        [LINE_SETTING_KEYS.channelSecret]: secret,
      });
      expect(overviewOf(await get(ADMIN).expect(200)).line.channelId).toBe(
        '2006••••11',
      );

      const body = JSON.stringify({ destination: 'Ue2e', events: [] });
      const sign = (s: string) =>
        createHmac('SHA256', s).update(body).digest('base64');
      await request(server())
        .post(url('/line/webhook'))
        .set('content-type', 'application/json')
        .set('x-line-signature', sign(secret))
        .send(body)
        .expect(200);
      await request(server())
        .post(url('/line/webhook'))
        .set('content-type', 'application/json')
        .set('x-line-signature', sign('cd'.repeat(16)))
        .send(body)
        .expect(401);
    });
  });

  describe('POST /system/integrations/line/verify', () => {
    it('returns bot info + quota and sends nothing', async () => {
      const res = await post(ADMIN, 'line/verify').expect(200);
      expect(res.body).toEqual({
        valid: true,
        botInfo: {
          basicId: '@easybook_th',
          displayName: 'EasyBook Bot',
          pictureUrl: null,
          chatMode: 'bot',
        },
        quota: { total: 500, used: 44 },
      });
      expect(fakeLine.pushMessage).not.toHaveBeenCalled();
      expect(fakeLine.multicast).not.toHaveBeenCalled();
    });

    it('LINE 401 → 503 LINE_NOT_CONFIGURED; LINE 500 → 503 LINE_UNAVAILABLE', async () => {
      fakeLine.getBotInfo.mockRejectedValue(httpError(401));
      expect(codeOf(await post(SUPER, 'line/verify').expect(503))).toBe(
        'LINE_NOT_CONFIGURED',
      );
      fakeLine.getBotInfo.mockRejectedValue(httpError(500));
      expect(codeOf(await post(SUPER, 'line/verify').expect(503))).toBe(
        'LINE_UNAVAILABLE',
      );
    });
  });

  describe('POST /system/integrations/storage/probe', () => {
    it('answers the probe result verbatim', async () => {
      const res = await post(ADMIN, 'storage/probe').expect(200);
      expect(res.body).toEqual({
        ok: true,
        latencyMs: 12,
        read: true,
        write: true,
      });
      expect(storageFake.probe).toHaveBeenCalledTimes(1);
    });
  });

  it('LAST — the tripwire recorded no LINE request, and settings are restored', async () => {
    expect(lineHits).toEqual([]);
    await restoreSettings();
    const after = await prisma.appSetting.findMany({
      where: { key: { in: KEYS } },
    });
    expect(after.map((r) => [r.key, r.value]).sort()).toEqual(
      snapshot.map((r) => [r.key, r.value]).sort(),
    );
  });
});
