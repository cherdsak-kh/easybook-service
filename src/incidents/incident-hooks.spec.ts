import { HTTPFetchError, messagingApi } from '@line/bot-sdk';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BadGatewayException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LineService } from '../line/line.service';
import { disabledTriggers } from '../notifications/triggers/triggers.test-kit';
import { RedisService } from '../redis/redis.service';
import { R2StorageService } from '../storage/r2-storage.service';
import { IMAGE_UPLOAD_FAILED } from '../storage/storage.errors';
import { IncidentRecorder } from './incident-recorder.service';
import { IncidentComponent, type ExternalOutcome } from './incident.types';

/**
 * Hub 6's hooks in the three single-owner clients (design §2.5.2): a failure is REPORTED, and nothing
 * the caller sees changes: same value, same error object, same status.
 */

const httpError = (status: number): HTTPFetchError =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{}',
  });

/** A recorder whose `track` runs for real (so wrappers are exercised) and `external` is observable. */
function fakeRecorder() {
  const external: ExternalOutcome[] = [];
  const recorder = {
    external: jest.fn((o: ExternalOutcome) => {
      external.push(o);
    }),
    track: jest.fn(
      async (
        component: IncidentComponent,
        operation: string,
        _budget: number,
        fn: () => Promise<unknown>,
      ) => {
        try {
          return await fn();
        } catch (error) {
          external.push({ component, operation, error });
          throw error;
        }
      },
    ),
  };
  return {
    recorder: recorder as unknown as IncidentRecorder,
    raw: recorder,
    external,
  };
}

describe('LineService hooks', () => {
  const config = {
    get: jest.fn((_k: string, fallback?: string) => fallback),
  } as unknown as ConfigService;

  beforeEach(() => {
    (['log', 'warn', 'error', 'debug'] as const).forEach((l) =>
      jest.spyOn(Logger.prototype, l).mockImplementation(() => undefined),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('push: returns the value, rethrows the SAME error, and reports the failure once', async () => {
    const boom = httpError(500);
    const client = { pushMessage: jest.fn().mockRejectedValue(boom) };
    const { recorder, external } = fakeRecorder();
    const service = new LineService(
      config,
      client as unknown as messagingApi.MessagingApiClient,
      disabledTriggers(),
      recorder,
    );
    await expect(
      service.push('Uabc', [{ type: 'text', text: 'x' }]),
    ).rejects.toBe(boom);
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      component: IncidentComponent.LINE_OA,
      operation: 'push',
    });
    expect(external[0].error).toBe(boom);

    client.pushMessage.mockResolvedValueOnce({ sentMessages: [] });
    await expect(
      service.push('Uabc', [{ type: 'text', text: 'x' }]),
    ).resolves.toEqual({
      sentMessages: [],
    });
  });

  it('works unchanged with NO recorder (the existing specs construct it this way)', async () => {
    const client = { pushMessage: jest.fn().mockResolvedValue('ok') };
    const service = new LineService(
      config,
      client as unknown as messagingApi.MessagingApiClient,
      disabledTriggers(),
    );
    await expect(
      service.push('Uabc', [{ type: 'text', text: 'x' }]),
    ).resolves.toBe('ok');
  });

  it('reply and getProfile are observed too', async () => {
    const client = {
      replyMessage: jest.fn().mockResolvedValue({}),
      getProfile: jest.fn().mockRejectedValue(httpError(404)),
    };
    const { recorder, raw } = fakeRecorder();
    const service = new LineService(
      config,
      client as unknown as messagingApi.MessagingApiClient,
      disabledTriggers(),
      recorder,
    );
    await service.reply('tok', []);
    await expect(service.getProfile('Uabc')).rejects.toBeInstanceOf(
      HTTPFetchError,
    );
    expect(raw.track.mock.calls.map((c) => c[1])).toEqual([
      'reply',
      'getProfile',
    ]);
  });

  it('multicast: one report per chunk with attempts, WARNING-eligible after a retry, and the outcome is unchanged', async () => {
    const client = {
      multicast: jest
        .fn()
        .mockRejectedValueOnce(httpError(500))
        .mockResolvedValueOnce({}),
    };
    const { recorder, external } = fakeRecorder();
    const service = new LineService(
      config,
      client as unknown as messagingApi.MessagingApiClient,
      disabledTriggers(),
      recorder,
    );
    const outcome = await service.multicast(
      ['U1', 'U2'],
      [{ type: 'text', text: 'x' }],
      {
        retryKeySeed: 'seed',
      },
    );
    expect(outcome).toMatchObject({
      acceptedCount: 2,
      requestCount: 2,
      failure: null,
    });
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      operation: 'multicast',
      attempts: 2,
      error: undefined,
    });
  });

  it('multicast: a final failure is reported with its error and still returned, not thrown', async () => {
    const boom = httpError(400);
    const client = { multicast: jest.fn().mockRejectedValue(boom) };
    const { recorder, external } = fakeRecorder();
    const service = new LineService(
      config,
      client as unknown as messagingApi.MessagingApiClient,
      disabledTriggers(),
      recorder,
    );
    const outcome = await service.multicast(
      ['U1'],
      [{ type: 'text', text: 'x' }],
      {
        retryKeySeed: 'seed',
      },
    );
    expect(outcome.failure).toMatchObject({ kind: 'REJECTED', status: 400 });
    expect(external[0].error).toBe(boom);
  });
});

describe('R2StorageService hooks', () => {
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'photos',
    R2_PUBLIC_BASE_URL: 'https://cdn.example.com',
  };
  const config = {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;

  beforeEach(() => {
    (['log', 'warn', 'error'] as const).forEach((l) =>
      jest.spyOn(Logger.prototype, l).mockImplementation(() => undefined),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('putImage: reports the failure (bucket and key prefix only) and still throws the same 502', async () => {
    jest
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('denied') as never);
    const { recorder, external } = fakeRecorder();
    const service = new R2StorageService(config, recorder);
    const result = service.putImage(
      'avatars/u1/abc.png',
      Buffer.from('x'),
      'image/png',
    );
    await expect(result).rejects.toBeInstanceOf(BadGatewayException);
    await expect(result).rejects.toMatchObject({
      message: IMAGE_UPLOAD_FAILED,
    });
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      component: IncidentComponent.CLOUDFLARE_R2,
      operation: 'putImage',
      context: { bucket: 'photos', keyPrefix: 'avatars/' },
    });
    expect(JSON.stringify(external[0].context)).not.toContain('abc.png');
  });

  it('swallowed failures are reported too, and still return false', async () => {
    jest
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('timeout') as never);
    const { recorder, external } = fakeRecorder();
    const service = new R2StorageService(config, recorder);
    await expect(service.deleteObject('venues/v1/a.jpg')).resolves.toBe(false);
    await expect(
      service.copyObject('venues/_new/a.jpg', 'venues/v1/a.jpg'),
    ).resolves.toBe(false);
    expect(external.map((e) => e.operation)).toEqual([
      'deleteObject',
      'copyObject',
    ]);
  });

  it('an unconfigured bucket (a config state) is NOT reported', async () => {
    const { recorder, external } = fakeRecorder();
    const service = new R2StorageService(
      {
        get: () => undefined,
        getOrThrow: () => undefined,
      } as unknown as ConfigService,
      recorder,
    );
    await expect(
      service.putImage('a/b.png', Buffer.from('x'), 'image/png'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(external).toHaveLength(0);
  });

  it('a success reports nothing and sends the command unchanged', async () => {
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    const { recorder, external } = fakeRecorder();
    await new R2StorageService(config, recorder).putImage(
      'a/b.png',
      Buffer.from('x'),
      'image/png',
    );
    expect(external).toHaveLength(0);
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
  });
});

describe('RedisService hooks', () => {
  it('reports a failed command (key family only) and still never throws', async () => {
    const client = {
      status: 'ready',
      get: jest.fn().mockRejectedValue(new Error('READONLY')),
      set: jest.fn().mockRejectedValue(new Error('READONLY')),
      del: jest.fn().mockRejectedValue(new Error('READONLY')),
    };
    const { recorder, external } = fakeRecorder();
    const service = new RedisService(client as never, recorder);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.getJson('opt:departments')).resolves.toBeNull();
    await expect(
      service.setJson('opt:departments', {}),
    ).resolves.toBeUndefined();
    await expect(service.del('opt:departments')).resolves.toBeUndefined();
    expect(external.map((e) => [e.component, e.operation])).toEqual([
      [IncidentComponent.REDIS, 'getJson'],
      [IncidentComponent.REDIS, 'setJson'],
      [IncidentComponent.REDIS, 'del'],
    ]);
    expect(external[0].context).toEqual({ keyPrefix: 'opt' });
    jest.restoreAllMocks();
  });

  it('reports nothing while the client is not ready (the client error listener owns that)', async () => {
    const client = { status: 'reconnecting', get: jest.fn() };
    const { recorder, external } = fakeRecorder();
    await expect(
      new RedisService(client as never, recorder).getJson('k'),
    ).resolves.toBeNull();
    expect(external).toHaveLength(0);
    expect(client.get).not.toHaveBeenCalled();
  });
});
