import { HTTPFetchError, messagingApi } from '@line/bot-sdk';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { LineCallError } from './line-call-error';
import { LineService } from './line.service';

/**
 * `INTEGRATIONS-API-1` — `getMessageQuota` and the runtime token swap, against a FAKE client.
 * 🔴 `useAccessToken` builds a real SDK client object, but nothing here CALLS it — constructing a
 * client makes no request.
 */

const config = {
  get: jest.fn((_key: string, fallback?: string) => fallback),
} as unknown as ConfigService;

const httpError = (status: number) =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{}',
  });

describe('LineService — getMessageQuota / useAccessToken', () => {
  const fake = {
    getMessageQuota: jest.fn(),
    getMessageQuotaConsumption: jest.fn(),
    pushMessage: jest.fn(),
    multicast: jest.fn(),
  };
  let service: LineService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new LineService(
      config,
      fake as unknown as messagingApi.MessagingApiClient,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('limited quota → { total: value, used: totalUsage }', async () => {
    fake.getMessageQuota.mockResolvedValue({ type: 'limited', value: 500 });
    fake.getMessageQuotaConsumption.mockResolvedValue({ totalUsage: 44 });
    await expect(service.getMessageQuota()).resolves.toEqual({
      total: 500,
      used: 44,
    });
  });

  it('type none → total null (no monthly limit)', async () => {
    fake.getMessageQuota.mockResolvedValue({ type: 'none' });
    fake.getMessageQuotaConsumption.mockResolvedValue({ totalUsage: 3 });
    await expect(service.getMessageQuota()).resolves.toEqual({
      total: null,
      used: 3,
    });
  });

  it('sends nothing — only the two quota reads are called', async () => {
    fake.getMessageQuota.mockResolvedValue({ type: 'limited', value: 1 });
    fake.getMessageQuotaConsumption.mockResolvedValue({ totalUsage: 0 });
    await service.getMessageQuota();
    expect(fake.pushMessage).not.toHaveBeenCalled();
    expect(fake.multicast).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'NOT_CONFIGURED'],
    [429, 'RATE_LIMITED'],
    [500, 'TRANSIENT'],
  ])('a %i is classified %s', async (status, kind) => {
    fake.getMessageQuota.mockRejectedValue(httpError(status));
    fake.getMessageQuotaConsumption.mockResolvedValue({ totalUsage: 0 });
    await expect(service.getMessageQuota()).rejects.toMatchObject({ kind });
  });

  it('no client → NOT_CONFIGURED without any call', async () => {
    const bare = new LineService(config, null);
    await expect(bare.getMessageQuota()).rejects.toEqual(
      new LineCallError('NOT_CONFIGURED', null),
    );
  });

  it('useAccessToken swaps the client; an empty token leaves NO client', () => {
    expect(service.isConfigured()).toBe(true);
    service.useAccessToken('x'.repeat(60));
    const swapped: unknown = Reflect.get(service, 'client');
    expect(swapped).toBeInstanceOf(messagingApi.MessagingApiClient);
    expect(swapped).not.toBe(fake);

    service.useAccessToken('');
    expect(service.isConfigured()).toBe(false);
  });

  it('never logs the token', () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const token = 'tok-' + 'y'.repeat(60);
    service.useAccessToken(token);
    for (const call of log.mock.calls as unknown[][]) {
      expect(String(call[0])).not.toContain(token);
    }
  });
});
