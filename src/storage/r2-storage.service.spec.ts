/**
 * Spec for `R2StorageService.sweepStagedPhotos` — the orphan venue-photo sweeper.
 *
 * ⚠️ THIS IS THE ONE SPEC IN THE REPO THAT MOCKS THE AWS SDK, and it does not contradict the rule
 * that says not to. Everywhere else (`avatar-upload.service.spec.ts`, the e2e app) mocks
 * `R2StorageService` itself, precisely because this service is THE seam onto `@aws-sdk/client-s3`.
 * A seam still needs one spec on the inside of it, and there was none before this file: nothing
 * covered `R2StorageService` directly. So `S3Client.prototype.send` is stubbed — the command objects
 * stay REAL, which is what lets these tests assert on `command.input` and catch a malformed request
 * rather than a malformed test double. No network is touched.
 */
import {
  BadGatewayException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  R2StorageService,
  VENUE_PHOTO_STAGING_PREFIX,
} from './r2-storage.service';
import { STORAGE_NOT_CONFIGURED, STORAGE_SWEEP_FAILED } from './storage.errors';

const BUCKET = 'easybook-test';

const ENV: Record<string, string> = {
  R2_ACCOUNT_ID: 'account-id',
  R2_ACCESS_KEY_ID: 'access-key-id',
  R2_SECRET_ACCESS_KEY: 'secret-access-key',
  R2_BUCKET: BUCKET,
  R2_PUBLIC_BASE_URL: 'https://pub-abc123.r2.dev',
};

const configOf = (
  env: Record<string, string | undefined> = ENV,
): ConfigService =>
  ({
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      const value = env[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    },
  }) as unknown as ConfigService;

const HOUR_MS = 60 * 60 * 1000;

interface StoredObject {
  Key: string;
  LastModified?: Date;
  Size?: number;
}

interface ListPage {
  Contents?: StoredObject[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

interface DeleteResult {
  Deleted?: { Key?: string }[];
  Errors?: { Key?: string; Code?: string }[];
}

/** A staged object last written `hoursAgo` hours ago. Keys are the shape the uploader mints. */
const stagedObject = (
  name: string,
  hoursAgo: number,
  size: number,
): StoredObject => ({
  Key: `${VENUE_PHOTO_STAGING_PREFIX}${name}.jpg`,
  LastModified: new Date(Date.now() - hoursAgo * HOUR_MS),
  Size: size,
});

const key = (name: string): string =>
  `${VENUE_PHOTO_STAGING_PREFIX}${name}.jpg`;

describe('R2StorageService.sweepStagedPhotos', () => {
  const send = jest.fn<Promise<unknown>, [unknown]>();
  let service: R2StorageService;

  /** Answer `ListObjectsV2` with `pages` in order, and `DeleteObjects` via `onDelete`. */
  const givenBucket = (
    pages: ListPage[],
    onDelete: (keys: string[]) => DeleteResult = (keys) => ({
      Deleted: keys.map((Key) => ({ Key })),
    }),
  ): void => {
    let pageIndex = 0;
    send.mockImplementation((command) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve(pages[pageIndex++] ?? {});
      }
      if (command instanceof DeleteObjectsCommand) {
        const keys = (command.input.Delete?.Objects ?? []).map(
          (object) => object.Key ?? '',
        );
        return Promise.resolve(onDelete(keys));
      }
      return Promise.reject(new Error(`Unexpected command: ${typeof command}`));
    });
  };

  const commandsOf = <T>(type: new (...args: never[]) => T): T[] =>
    send.mock.calls
      .map(([command]) => command)
      .filter((command): command is T => command instanceof type);

  const deletedKeys = (): string[] =>
    commandsOf(DeleteObjectsCommand).flatMap((command) =>
      (command.input.Delete?.Objects ?? []).map((object) => object.Key ?? ''),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    // Frozen clock: the cutoff is computed inside the method, so a boundary case would otherwise
    // drift by however many milliseconds the test took to get there.
    jest.useFakeTimers().setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(send as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    service = new R2StorageService(configOf());
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('lists the staging prefix in the configured bucket, and nothing else', async () => {
    givenBucket([{ Contents: [] }]);

    await service.sweepStagedPhotos();

    const listed = commandsOf(ListObjectsV2Command);
    expect(listed).toHaveLength(1);
    expect(listed[0].input.Bucket).toBe(BUCKET);
    expect(listed[0].input.Prefix).toBe(VENUE_PHOTO_STAGING_PREFIX);
  });

  it('deletes only what is older than 24h — a photo uploaded minutes ago survives', async () => {
    givenBucket([
      {
        Contents: [
          stagedObject('old-a', 48, 1000),
          stagedObject('fresh-a', 0.5, 9999),
          stagedObject('old-b', 25, 500),
          // Exactly at the cutoff: NOT strictly older, so it stays. The boundary belongs to the
          // operator, not to the sweeper.
          stagedObject('boundary', 24, 7777),
        ],
        IsTruncated: false,
      },
    ]);

    const result = await service.sweepStagedPhotos();

    expect(deletedKeys()).toEqual([key('old-a'), key('old-b')]);
    expect(result).toEqual({
      scannedCount: 4,
      eligibleCount: 2,
      deletedCount: 2,
      freedBytes: 1500,
      dryRun: false,
    });
  });

  it('honours a custom olderThanMs', async () => {
    givenBucket([
      {
        Contents: [
          stagedObject('two-hours', 2, 100),
          stagedObject('new', 0.5, 100),
        ],
      },
    ]);

    const result = await service.sweepStagedPhotos({ olderThanMs: HOUR_MS });

    expect(deletedKeys()).toEqual([key('two-hours')]);
    expect(result.eligibleCount).toBe(1);
  });

  it('dry run sends NO delete command, yet still reports what would go', async () => {
    givenBucket([
      {
        Contents: [
          stagedObject('old-a', 48, 1000),
          stagedObject('old-b', 30, 250),
          stagedObject('fresh', 1, 4000),
        ],
      },
    ]);

    const result = await service.sweepStagedPhotos({ dryRun: true });

    expect(commandsOf(DeleteObjectsCommand)).toHaveLength(0);
    expect(result).toEqual({
      scannedCount: 3,
      eligibleCount: 2,
      // On a dry run this is the eligible set's bytes — the upper bound of what a real run frees.
      freedBytes: 1250,
      deletedCount: 0,
      dryRun: true,
    });
  });

  it('follows pagination: page two carries the continuation token and both pages count', async () => {
    givenBucket([
      {
        Contents: [
          stagedObject('page1-old', 48, 100),
          stagedObject('page1-new', 1, 100),
        ],
        IsTruncated: true,
        NextContinuationToken: 'token-page-2',
      },
      {
        Contents: [stagedObject('page2-old', 72, 200)],
        IsTruncated: false,
      },
    ]);

    const result = await service.sweepStagedPhotos();

    const listed = commandsOf(ListObjectsV2Command);
    expect(listed).toHaveLength(2);
    expect(listed[0].input.ContinuationToken).toBeUndefined();
    expect(listed[1].input.ContinuationToken).toBe('token-page-2');
    expect(deletedKeys()).toEqual([key('page1-old'), key('page2-old')]);
    expect(result).toMatchObject({
      scannedCount: 3,
      eligibleCount: 2,
      deletedCount: 2,
      freedBytes: 300,
    });
  });

  it('stops paginating when IsTruncated is false even if a stale token comes back', async () => {
    givenBucket([
      {
        Contents: [stagedObject('only', 48, 10)],
        IsTruncated: false,
        NextContinuationToken: 'token-that-must-be-ignored',
      },
    ]);

    await service.sweepStagedPhotos();

    expect(commandsOf(ListObjectsV2Command)).toHaveLength(1);
  });

  it('an empty staging folder deletes nothing, returns zeros and does not throw', async () => {
    givenBucket([{}]);

    const result = await service.sweepStagedPhotos();

    expect(commandsOf(DeleteObjectsCommand)).toHaveLength(0);
    expect(result).toEqual({
      scannedCount: 0,
      eligibleCount: 0,
      deletedCount: 0,
      freedBytes: 0,
      dryRun: false,
    });
  });

  it('a bucket holding only fresh objects sends no delete command', async () => {
    givenBucket([{ Contents: [stagedObject('fresh', 2, 500)] }]);

    const result = await service.sweepStagedPhotos();

    expect(commandsOf(DeleteObjectsCommand)).toHaveLength(0);
    expect(result.scannedCount).toBe(1);
    expect(result.eligibleCount).toBe(0);
  });

  it('does not over-report when R2 refuses individual keys', async () => {
    givenBucket(
      [
        {
          Contents: [
            stagedObject('ok-a', 48, 100),
            stagedObject('ok-b', 48, 200),
            stagedObject('refused', 48, 400),
          ],
        },
      ],
      (keys) => ({
        Deleted: keys
          .filter((k) => k !== key('refused'))
          .map((Key) => ({ Key })),
        Errors: [{ Key: key('refused'), Code: 'AccessDenied' }],
      }),
    );

    const result = await service.sweepStagedPhotos();

    // Asked for 3, R2 confirmed 2 — the answer is 2, and the refused object's bytes are not claimed.
    expect(result.eligibleCount).toBe(3);
    expect(result.deletedCount).toBe(2);
    expect(result.freedBytes).toBe(300);
  });

  it('chunks deletes at the 1000-key API limit', async () => {
    const contents = Array.from({ length: 1001 }, (_, i) =>
      stagedObject(`old-${i}`, 48, 1),
    );
    givenBucket([{ Contents: contents }]);

    const result = await service.sweepStagedPhotos();

    const deletes = commandsOf(DeleteObjectsCommand);
    expect(deletes).toHaveLength(2);
    expect(deletes[0].input.Delete?.Objects).toHaveLength(1000);
    expect(deletes[1].input.Delete?.Objects).toHaveLength(1);
    expect(result.deletedCount).toBe(1001);
  });

  it('skips an object with no LastModified — no timestamp, no proof it is abandoned', async () => {
    givenBucket([
      {
        Contents: [
          { Key: key('undated'), Size: 100 },
          stagedObject('old', 48, 50),
        ],
      },
    ]);

    const result = await service.sweepStagedPhotos();

    expect(deletedKeys()).toEqual([key('old')]);
    expect(result.scannedCount).toBe(2);
    expect(result.eligibleCount).toBe(1);
  });

  it('turns an SDK failure into a 502 rather than a silent zero', async () => {
    send.mockRejectedValue(new Error('connection reset'));

    await expect(service.sweepStagedPhotos()).rejects.toThrow(
      BadGatewayException,
    );
    await expect(service.sweepStagedPhotos()).rejects.toThrow(
      STORAGE_SWEEP_FAILED,
    );
  });

  it('refuses to run at all when R2 is not configured, and touches no SDK', async () => {
    const unconfigured = new R2StorageService(configOf({}));

    await expect(unconfigured.sweepStagedPhotos()).rejects.toThrow(
      InternalServerErrorException,
    );
    await expect(unconfigured.sweepStagedPhotos()).rejects.toThrow(
      STORAGE_NOT_CONFIGURED,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
