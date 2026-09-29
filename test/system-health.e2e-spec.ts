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
 * `GET /api/v1/system/health` — Reports Phase 1 (design §2.4). Mirrors
 * `system-integrations.e2e-spec.ts`'s fake-LINE-client + fetch-tripwire discipline: NOTHING here may
 * reach real LINE or real R2. `R2StorageService` is replaced with a fake carrying `probeRead` (the
 * new Phase-1 method); `LINE_MESSAGING_CLIENT` is replaced and proven wired via the same tripwire.
 *
 * The `AppSetting` LINE keys are snapshotted/restored exactly as that suite does, since this file
 * also exercises `PATCH /system/integrations/line` to prove the cache-drop regression (D-8).
 */

const PREFIX = 'e2e-health-';
const PASSWORD = 'E2e-correct-horse-battery-1';
const SUPER = `${PREFIX}super@easybook.local`;
const ADMIN = `${PREFIX}admin@easybook.local`;
const VIEWER = `${PREFIX}viewer@easybook.local`;

const KEYS = Object.values(LINE_SETTING_KEYS);
const TRIPWIRE = 'e2e tripwire: LINE is unreachable from this suite';

const url = (path: string) => `${API_BASE_PATH}${path}`;

interface Session {
  agent: request.Agent;
  token: string;
}

interface HealthBody {
  checkedAt: string;
  overall: 'OK' | 'DEGRADED';
  detail: 'FULL' | 'SUMMARY';
  services: {
    database: { status: string };
    line: { status: string };
    storage: { status: string };
  };
  telemetry: null | {
    database: { latencyMs: number };
    line: {
      quotaTotal: number | null;
      quotaUsed: number | null;
      quotaRemaining: number | null;
    };
    storage: { latencyMs: number | null };
  };
}

const httpError = (status: number) =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{}',
  });

describe('System health (e2e)', () => {
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
    probeRead: jest
      .fn()
      .mockResolvedValue({ configured: true, ok: true, latencyMs: 12 }),
  };

  const server = () => app.getHttpServer();
  const as = (email: string) => sessions[email];
  const getHealth = (email: string) =>
    as(email).agent.get(url('/system/health'));

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

  const goodLine = () => {
    fakeLine.getMessageQuota.mockResolvedValue({ type: 'limited', value: 500 });
    fakeLine.getMessageQuotaConsumption.mockResolvedValue({ totalUsage: 44 });
  };

  const restoreSettings = async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
    if (snapshot.length) await prisma.appSetting.createMany({ data: snapshot });
  };

  /** Drops the health caches directly — each test starts from a clean cache, not a shared one. */
  const dropHealthCache = async () => {
    await redis.del('eb:cache:health:line', 'eb:cache:health:r2');
  };

  beforeAll(async () => {
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

    app = await createE2eApp((b) =>
      b
        .overrideProvider(LINE_MESSAGING_CLIENT)
        .useValue(fakeLine)
        .overrideProvider(R2StorageService)
        .useValue(storageFake),
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

  beforeEach(async () => {
    jest.clearAllMocks();
    goodLine();
    storageFake.isConfigured.mockReturnValue(true);
    storageFake.probeRead.mockResolvedValue({
      configured: true,
      ok: true,
      latencyMs: 12,
    });
    await dropHealthCache();
  });

  afterAll(async () => {
    if (prisma) {
      await restoreSettings();
      await purgeE2eUsers(prisma, PREFIX);
    }
    if (app) await app.close();
    global.fetch = realFetch;
  });

  describe('role gating', () => {
    it('no session -> 401', async () => {
      await request(server()).get(url('/system/health')).expect(401);
    });

    it('SUPER_ADMIN, ADMIN and VIEWER all get 200 (D-15) — always 200, never a probe-failure 5xx', async () => {
      for (const who of [SUPER, ADMIN, VIEWER]) {
        await getHealth(who).expect(200);
      }
    });
  });

  describe('AC-D16/AC-D17 — role-shaped telemetry', () => {
    it('SUPER_ADMIN gets detail=FULL with numeric telemetry', async () => {
      const body = (await getHealth(SUPER).expect(200)).body as HealthBody;
      expect(body.detail).toBe('FULL');
      expect(body.telemetry).not.toBeNull();
      expect(typeof body.telemetry?.database.latencyMs).toBe('number');
      expect(body.telemetry?.line.quotaTotal).toBe(500);
      expect(body.telemetry?.line.quotaUsed).toBe(44);
      expect(body.telemetry?.line.quotaRemaining).toBe(456);
      expect(typeof body.telemetry?.storage.latencyMs).toBe('number');
    });

    it('ADMIN and VIEWER get detail=SUMMARY, telemetry=null, and the RAW JSON carries no numeric keys', async () => {
      for (const who of [ADMIN, VIEWER]) {
        const res = await getHealth(who).expect(200);
        const body = res.body as HealthBody;
        expect(body.detail).toBe('SUMMARY');
        expect(body.telemetry).toBeNull();
        // AC-D17: verified on the raw JSON, not the DOM.
        expect(JSON.stringify(res.body)).not.toMatch(
          /latency|quota|observedAt/i,
        );
        expect(Object.keys(body.services.database)).toEqual(['status']);
        expect(Object.keys(body.services.line)).toEqual(['status']);
        expect(Object.keys(body.services.storage)).toEqual(['status']);
      }
    });
  });

  describe('AC-D4/overall', () => {
    it('everything up -> overall OK', async () => {
      const body = (await getHealth(SUPER).expect(200)).body as HealthBody;
      expect(body.overall).toBe('OK');
      expect(body.services.database.status).toBe('UP');
      expect(body.services.line.status).toBe('UP');
      expect(body.services.storage.status).toBe('UP');
    });

    it('LINE down -> services.line.status=DOWN and overall=DEGRADED; DB/storage unaffected (AC-D19)', async () => {
      fakeLine.getMessageQuota.mockRejectedValue(httpError(500));
      fakeLine.getMessageQuotaConsumption.mockRejectedValue(httpError(500));
      const body = (await getHealth(SUPER).expect(200)).body as HealthBody;
      expect(body.services.line.status).toBe('DOWN');
      expect(body.overall).toBe('DEGRADED');
      expect(body.services.database.status).toBe('UP');
      expect(body.services.storage.status).toBe('UP');
    });

    it('R2 unconfigured -> NOT_CONFIGURED, and it never degrades overall (D-8)', async () => {
      storageFake.isConfigured.mockReturnValue(false);
      const body = (await getHealth(SUPER).expect(200)).body as HealthBody;
      expect(body.services.storage.status).toBe('NOT_CONFIGURED');
      expect(body.overall).toBe('OK');
      expect(body.telemetry?.storage.latencyMs).toBeNull();
    });
  });

  describe('AC-D20 — caching', () => {
    it('two consecutive calls within the cache window make at most one LINE call and one R2 call', async () => {
      await getHealth(SUPER).expect(200);
      await getHealth(SUPER).expect(200);
      expect(fakeLine.getMessageQuota).toHaveBeenCalledTimes(1);
      expect(storageFake.probeRead).toHaveBeenCalledTimes(1);
    });

    it('D-8: PATCH /system/integrations/line drops the LINE health cache, so the next health call re-probes', async () => {
      await getHealth(SUPER).expect(200);
      expect(fakeLine.getMessageQuota).toHaveBeenCalledTimes(1);

      await as(SUPER)
        .agent.patch(url('/system/integrations/line'))
        .set('x-csrf-token', as(SUPER).token)
        .send({ channelId: '2006999911' })
        .expect(200);

      await getHealth(SUPER).expect(200);
      expect(fakeLine.getMessageQuota).toHaveBeenCalledTimes(2);
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
