import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { API_BASE_PATH } from '../common/api.constants';
import type { LineCredentialsService } from '../line/line-credentials.service';
import { LineCallError } from '../line/line-call-error';
import type { LineService } from '../line/line.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import type { R2StorageService } from '../storage/r2-storage.service';
import { IntegrationsService } from './integrations.service';
import type { SwaggerGateService } from './swagger-gate.service';

/** `INTEGRATIONS-API-1` — overview shape and fail-softness, validation, and error mapping. */

const BOT = {
  basicId: '@easybook_th',
  displayName: 'EasyBook Bot',
  pictureUrl: null,
  chatMode: 'bot' as const,
  markAsReadMode: 'auto' as const,
};

/** Only the keys `IntegrationsService` reads; `env` overrides/extends them per test. */
function build(
  over: {
    lineConfigured?: boolean;
    env?: Record<string, string | number | undefined>;
  } = {},
) {
  const gate = {
    isEnabled: jest.fn().mockReturnValue(false),
    set: jest.fn((v: boolean) => Promise.resolve(v)),
  };
  const line = {
    getBotInfo: jest.fn().mockResolvedValue(BOT),
    getMessageQuota: jest.fn().mockResolvedValue({ total: 500, used: 44 }),
    push: jest.fn(),
    multicast: jest.fn(),
  };
  const credentials = {
    isConfigured: jest.fn().mockReturnValue(over.lineConfigured ?? true),
    maskedChannelId: jest.fn().mockReturnValue('2006••••42'),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    isConfigured: jest.fn().mockReturnValue(true),
    publicBaseUrl: jest.fn().mockReturnValue('https://pub-x.r2.dev'),
    probe: jest
      .fn()
      .mockResolvedValue({ ok: true, latencyMs: 40, read: true, write: true }),
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  const redis = { isHealthy: jest.fn().mockResolvedValue(true) };
  const env: Record<string, string | number | undefined> = {
    R2_BUCKET: 'easybook-dev',
    ...over.env,
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const svc = new IntegrationsService(
    gate as unknown as SwaggerGateService,
    line as unknown as LineService,
    credentials as unknown as LineCredentialsService,
    storage as unknown as R2StorageService,
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
  );
  return { svc, gate, line, credentials, storage, prisma, redis };
}

describe('IntegrationsService', () => {
  describe('overview()', () => {
    it('returns the documented shape, masked, with markAsReadMode dropped', async () => {
      const { svc } = build();
      const res = await svc.overview();
      expect(res.swagger).toEqual({
        enabled: false,
        docsUrl: 'http://localhost:3300/docs',
      });
      expect(res.line).toEqual({
        configured: true,
        channelId: '2006••••42',
        botInfo: {
          basicId: '@easybook_th',
          displayName: 'EasyBook Bot',
          pictureUrl: null,
          chatMode: 'bot',
        },
        quota: { total: 500, used: 44 },
        webhookUrl: 'http://localhost:3300/api/v1/line/webhook',
      });
      expect(res.storage).toEqual({
        configured: true,
        bucket: 'easybook-dev',
        publicBaseUrl: 'https://pub-x.r2.dev',
      });
      expect(res.infrastructure.database.status).toBe('ok');
      expect(res.infrastructure.redis.status).toBe('up');
    });

    it('never contains a secret or token field', async () => {
      const json = JSON.stringify(await build().svc.overview());
      expect(json).not.toMatch(/secret|token/i);
    });

    it('unconfigured LINE → no LINE call, botInfo/quota null', async () => {
      const { svc, line } = build({ lineConfigured: false });
      const res = await svc.overview();
      expect(line.getBotInfo).not.toHaveBeenCalled();
      expect(line.getMessageQuota).not.toHaveBeenCalled();
      expect(res.line.botInfo).toBeNull();
      expect(res.line.quota).toBeNull();
      // The admin registers the webhook BEFORE saving the credentials it produces.
      expect(res.line.webhookUrl).toBe(
        'http://localhost:3300/api/v1/line/webhook',
      );
    });

    it('fail-soft: LINE, Postgres and Redis all failing still resolves 200-shaped', async () => {
      const { svc, line, prisma, redis } = build();
      line.getBotInfo.mockRejectedValue(new LineCallError('TRANSIENT', null));
      line.getMessageQuota.mockRejectedValue(
        new LineCallError('TRANSIENT', null),
      );
      prisma.$queryRaw.mockRejectedValue(new Error('db down'));
      redis.isHealthy.mockResolvedValue(false);
      const res = await svc.overview();
      expect(res.line.botInfo).toBeNull();
      expect(res.line.quota).toBeNull();
      expect(res.infrastructure.database.status).toBe('error');
      expect(res.infrastructure.redis.status).toBe('down');
    });

    it('a slow database reads as degraded', async () => {
      jest.useFakeTimers();
      try {
        const { svc, prisma } = build();
        prisma.$queryRaw.mockImplementation(
          () => new Promise((r) => setTimeout(() => r([]), 250)),
        );
        const pending = svc.overview();
        await jest.advanceTimersByTimeAsync(260);
        expect((await pending).infrastructure.database.status).toBe('degraded');
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The canonical public URLs (`docsUrl` / `webhookUrl`). The browser cannot derive these —
     * `window.location.origin` names the FRONTEND, which LINE cannot call and which does not
     * serve `/docs`.
     */
    describe('canonical URLs', () => {
      it('falls back to localhost:PORT when API_EXTERNAL_URL is unset', async () => {
        const res = await build({ env: { PORT: 4100 } }).svc.overview();
        expect(res.swagger.docsUrl).toBe('http://localhost:4100/docs');
        expect(res.line.webhookUrl).toBe(
          'http://localhost:4100/api/v1/line/webhook',
        );
      });

      it('falls back to port 3300 when PORT is unset too', async () => {
        const res = await build().svc.overview();
        expect(res.swagger.docsUrl).toBe('http://localhost:3300/docs');
        expect(res.line.webhookUrl).toBe(
          'http://localhost:3300/api/v1/line/webhook',
        );
      });

      it('uses API_EXTERNAL_URL when set', async () => {
        const res = await build({
          env: { API_EXTERNAL_URL: 'https://api.example.com' },
        }).svc.overview();
        expect(res.swagger.docsUrl).toBe('https://api.example.com/docs');
        expect(res.line.webhookUrl).toBe(
          'https://api.example.com/api/v1/line/webhook',
        );
      });

      it.each(['https://api.example.com/', 'https://api.example.com///'])(
        'strips trailing slashes: %s',
        async (value) => {
          const res = await build({
            env: { API_EXTERNAL_URL: value },
          }).svc.overview();
          expect(res.swagger.docsUrl).toBe('https://api.example.com/docs');
          expect(res.line.webhookUrl).toBe(
            'https://api.example.com/api/v1/line/webhook',
          );
          // No doubled slash anywhere after the scheme.
          for (const url of [res.swagger.docsUrl, res.line.webhookUrl]) {
            expect(url.replace(/^https?:\/\//, '')).not.toContain('//');
          }
        },
      );

      it('carries a reverse-proxy path prefix through untouched', async () => {
        const res = await build({
          env: { API_EXTERNAL_URL: 'https://x.ac.th/eb/' },
        }).svc.overview();
        expect(res.swagger.docsUrl).toBe('https://x.ac.th/eb/docs');
        expect(res.line.webhookUrl).toBe(
          'https://x.ac.th/eb/api/v1/line/webhook',
        );
      });

      it('builds the webhook path from API_BASE_PATH, not a hardcoded string', async () => {
        const res = await build({
          env: { API_EXTERNAL_URL: 'https://api.example.com' },
        }).svc.overview();
        expect(res.line.webhookUrl).toBe(
          `https://api.example.com${API_BASE_PATH}/line/webhook`,
        );
      });

      it('both fields survive Swagger ON and LINE unconfigured', async () => {
        const { svc, gate } = build({ lineConfigured: false });
        gate.isEnabled.mockReturnValue(true);
        const res = await svc.overview();
        expect(res.swagger.enabled).toBe(true);
        expect(res.swagger.docsUrl).toBe('http://localhost:3300/docs');
        expect(res.line.configured).toBe(false);
        expect(res.line.webhookUrl).toBe(
          'http://localhost:3300/api/v1/line/webhook',
        );
      });

      // `/docs` is served at the ROOT by `mountSwagger`, never under the global prefix.
      it('docsUrl does not carry the API prefix', async () => {
        const res = await build().svc.overview();
        expect(res.swagger.docsUrl).not.toContain(API_BASE_PATH);
      });
    });

    it('never sends a LINE message', async () => {
      const { svc, line } = build();
      await svc.overview();
      await svc.verifyLine();
      expect(line.push).not.toHaveBeenCalled();
      expect(line.multicast).not.toHaveBeenCalled();
    });
  });

  describe('updateLine()', () => {
    it('an empty body is 400 LINE_UPDATE_EMPTY and writes nothing', async () => {
      const { svc, credentials } = build();
      const err = await svc.updateLine({}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        code: 'LINE_UPDATE_EMPTY',
      });
      expect(credentials.update).not.toHaveBeenCalled();
    });

    it('passes the fields through and answers the masked id', async () => {
      const { svc, credentials } = build();
      await expect(
        svc.updateLine({ channelId: '2006123442' }),
      ).resolves.toEqual({
        success: true,
        maskedChannelId: '2006••••42',
      });
      expect(credentials.update).toHaveBeenCalledWith({
        channelId: '2006123442',
        channelSecret: undefined,
        channelAccessToken: undefined,
      });
    });
  });

  describe('verifyLine()', () => {
    it('ok → valid + botInfo + quota', async () => {
      await expect(build().svc.verifyLine()).resolves.toEqual({
        valid: true,
        botInfo: {
          basicId: '@easybook_th',
          displayName: 'EasyBook Bot',
          pictureUrl: null,
          chatMode: 'bot',
        },
        quota: { total: 500, used: 44 },
      });
    });

    it.each([
      ['NOT_CONFIGURED', 'LINE_NOT_CONFIGURED'],
      ['RATE_LIMITED', 'LINE_UNAVAILABLE'],
      ['TRANSIENT', 'LINE_UNAVAILABLE'],
      ['REJECTED', 'LINE_UNAVAILABLE'],
    ] as const)('%s → 503 %s', async (kind, code) => {
      const { svc, line } = build();
      line.getBotInfo.mockRejectedValue(new LineCallError(kind, null));
      const err = await svc.verifyLine().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        statusCode: 503,
        code,
      });
    });
  });

  it('setSwagger delegates to the gate', async () => {
    const { svc, gate } = build();
    await expect(svc.setSwagger(true)).resolves.toEqual({
      success: true,
      enabled: true,
    });
    expect(gate.set).toHaveBeenCalledWith(true);
  });

  it('probeStorage delegates to R2StorageService.probe', async () => {
    const { svc, storage } = build();
    await expect(svc.probeStorage()).resolves.toMatchObject({ ok: true });
    expect(storage.probe).toHaveBeenCalled();
  });
});
