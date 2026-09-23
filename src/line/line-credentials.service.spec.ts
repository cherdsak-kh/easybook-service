import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import {
  LINE_SETTING_KEYS,
  LineCredentialsService,
  maskChannelId,
} from './line-credentials.service';
import type { LineService } from './line.service';

/** `INTEGRATIONS-API-1` — stored credentials over env, the test-mode guard, and write-through. */

const config = (secret = 'env-secret') =>
  ({
    get: jest.fn((key: string, fallback?: string) =>
      key === 'LINE_CHANNEL_SECRET' ? secret : fallback,
    ),
  }) as unknown as ConfigService;

const makePrisma = (rows: Array<{ key: string; value: string }> = []) => {
  const upsert = jest.fn((args: unknown) => args);
  return {
    appSetting: { findMany: jest.fn().mockResolvedValue(rows), upsert },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
};

const makeLine = () => ({
  useAccessToken: jest.fn(),
  isConfigured: jest.fn().mockReturnValue(true),
});

describe('maskChannelId', () => {
  it('keeps the first 4 and last 2', () => {
    expect(maskChannelId('2006123442')).toBe('2006••••42');
  });
  it('returns a short value whole', () => {
    expect(maskChannelId('123')).toBe('123');
  });
});

describe('LineCredentialsService', () => {
  const originalEnv = process.env.NODE_ENV;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.restoreAllMocks();
  });

  const stored = [
    { key: LINE_SETTING_KEYS.channelId, value: '2006123442' },
    { key: LINE_SETTING_KEYS.channelSecret, value: 'a'.repeat(32) },
    { key: LINE_SETTING_KEYS.channelAccessToken, value: 't'.repeat(60) },
  ];

  it('without stored rows: env secret, no channel id', async () => {
    process.env.NODE_ENV = 'development';
    const svc = new LineCredentialsService(
      makePrisma() as unknown as PrismaService,
      makeLine() as unknown as LineService,
      config(),
    );
    await svc.onModuleInit();
    expect(svc.channelSecret()).toBe('env-secret');
    expect(svc.maskedChannelId()).toBeNull();
  });

  it('stored rows win over env, and the token is applied to LineService', async () => {
    process.env.NODE_ENV = 'development';
    const line = makeLine();
    const svc = new LineCredentialsService(
      makePrisma(stored) as unknown as PrismaService,
      line as unknown as LineService,
      config(),
    );
    await svc.onModuleInit();
    expect(svc.channelSecret()).toBe('a'.repeat(32));
    expect(svc.maskedChannelId()).toBe('2006••••42');
    expect(line.useAccessToken).toHaveBeenCalledWith('t'.repeat(60));
  });

  it('🔴 NODE_ENV=test ignores stored rows entirely (the e2e fake client must survive)', async () => {
    process.env.NODE_ENV = 'test';
    const prisma = makePrisma(stored);
    const line = makeLine();
    const svc = new LineCredentialsService(
      prisma as unknown as PrismaService,
      line as unknown as LineService,
      config(),
    );
    await svc.onModuleInit();
    expect(prisma.appSetting.findMany).not.toHaveBeenCalled();
    expect(line.useAccessToken).not.toHaveBeenCalled();
    expect(svc.channelSecret()).toBe('env-secret');
  });

  it('a failed settings read keeps env values instead of failing boot', async () => {
    process.env.NODE_ENV = 'development';
    const prisma = makePrisma();
    prisma.appSetting.findMany.mockRejectedValue(new Error('db down'));
    const svc = new LineCredentialsService(
      prisma as unknown as PrismaService,
      makeLine() as unknown as LineService,
      config(),
    );
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(svc.channelSecret()).toBe('env-secret');
  });

  it('update persists only the given fields, then applies them', async () => {
    const prisma = makePrisma();
    const line = makeLine();
    const svc = new LineCredentialsService(
      prisma as unknown as PrismaService,
      line as unknown as LineService,
      config(),
    );
    await svc.update({
      channelId: '2006555511',
      channelSecret: 'b'.repeat(32),
    });

    expect(prisma.appSetting.upsert).toHaveBeenCalledTimes(2);
    const keys = prisma.appSetting.upsert.mock.calls.map(
      (c) => (c[0] as { where: { key: string } }).where.key,
    );
    expect(keys).toEqual([
      LINE_SETTING_KEYS.channelId,
      LINE_SETTING_KEYS.channelSecret,
    ]);
    expect(svc.maskedChannelId()).toBe('2006••••11');
    expect(svc.channelSecret()).toBe('b'.repeat(32));
    expect(line.useAccessToken).not.toHaveBeenCalled();
  });

  it('update with a token swaps the live client, and logs field names only', async () => {
    const line = makeLine();
    const svc = new LineCredentialsService(
      makePrisma() as unknown as PrismaService,
      line as unknown as LineService,
      config(),
    );
    const token = 'z'.repeat(80);
    await svc.update({ channelAccessToken: token });
    expect(line.useAccessToken).toHaveBeenCalledWith(token);
    for (const call of logSpy.mock.calls as unknown[][]) {
      expect(String(call[0])).not.toContain(token);
    }
  });
});
