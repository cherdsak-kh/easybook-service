/**
 * Spec for `R2StorageService.probe` (`INTEGRATIONS-API-1`). Same seam as
 * `r2-storage.service.spec.ts`: `S3Client.prototype.send` is stubbed, the command objects stay REAL,
 * and no network is touched.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { R2StorageService } from './r2-storage.service';

const ENV: Record<string, string> = {
  R2_ACCOUNT_ID: 'account-id',
  R2_ACCESS_KEY_ID: 'access-key-id',
  R2_SECRET_ACCESS_KEY: 'secret-access-key',
  R2_BUCKET: 'easybook-test',
  R2_PUBLIC_BASE_URL: 'https://pub-abc123.r2.dev',
};

const configOf = (env: Record<string, string | undefined> = ENV) =>
  ({
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      const value = env[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    },
  }) as unknown as ConfigService;

describe('R2StorageService.probe', () => {
  let send: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    send = jest.spyOn(S3Client.prototype, 'send');
  });
  afterEach(() => jest.restoreAllMocks());

  it('unconfigured → all false, latency 0, no S3 call', async () => {
    const svc = new R2StorageService(configOf({}));
    await expect(svc.probe()).resolves.toEqual({
      ok: false,
      latencyMs: 0,
      read: false,
      write: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('list → put → delete, all under _healthcheck/, with the same random key', async () => {
    send.mockResolvedValue({});
    const res = await new R2StorageService(configOf()).probe();
    expect(res).toMatchObject({ ok: true, read: true, write: true });

    const commands = (send.mock.calls as unknown[][]).map(
      (c) => c[0] as { input: Record<string, unknown> },
    );
    expect(commands[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(commands[0].input).toMatchObject({
      Prefix: '_healthcheck/',
      MaxKeys: 1,
    });
    expect(commands[1]).toBeInstanceOf(PutObjectCommand);
    expect(commands[2]).toBeInstanceOf(DeleteObjectCommand);
    const key = commands[1].input.Key as string;
    expect(key).toMatch(/^_healthcheck\/probe-[0-9a-f]{16}\.txt$/);
    expect(commands[2].input.Key).toBe(key);
  });

  it('a failed write is reported, never thrown, and skips the delete', async () => {
    send.mockImplementation((cmd: unknown) =>
      cmd instanceof PutObjectCommand
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({}),
    );
    const res = await new R2StorageService(configOf()).probe();
    expect(res).toMatchObject({ ok: false, read: true, write: false });
    expect(
      (send.mock.calls as unknown[][]).some(
        (c) => c[0] instanceof DeleteObjectCommand,
      ),
    ).toBe(false);
  });

  it('a failed read is reported, never thrown', async () => {
    send.mockImplementation((cmd: unknown) =>
      cmd instanceof ListObjectsV2Command
        ? Promise.reject(new Error('NoSuchBucket'))
        : Promise.resolve({}),
    );
    await expect(
      new R2StorageService(configOf()).probe(),
    ).resolves.toMatchObject({
      ok: false,
      read: false,
      write: true,
    });
  });
});
