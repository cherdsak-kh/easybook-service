import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import {
  ORPHAN_PHOTO_SWEEP_CRON,
  OrphanPhotoSweeperCron,
} from './orphan-photo-sweeper.cron';
import type {
  R2StorageService,
  StagedPhotoSweepResult,
} from './r2-storage.service';
import { STAGED_PHOTO_MIN_AGE_MS } from './r2-storage.service';
import { StorageModule } from './storage.module';

/**
 * ⚠️ THE SUBJECT IS CONSTRUCTED BY HAND, never through `Test.createTestingModule`. Booting
 * `ScheduleModule` here would register a real `CronJob` — an open handle in a suite whose entire
 * point is that no such handle exists.
 */
const RESULT: StagedPhotoSweepResult = {
  scannedCount: 12,
  eligibleCount: 3,
  deletedCount: 3,
  freedBytes: 4096,
  dryRun: false,
};

type StorageStub = {
  isConfigured: jest.Mock<boolean, []>;
  sweepStagedPhotos: jest.Mock<Promise<StagedPhotoSweepResult>, [unknown?]>;
};

const makeStorage = (): StorageStub => ({
  isConfigured: jest.fn<boolean, []>().mockReturnValue(true),
  sweepStagedPhotos: jest
    .fn<Promise<StagedPhotoSweepResult>, [unknown?]>()
    .mockResolvedValue(RESULT),
});

const subject = (storage: StorageStub): OrphanPhotoSweeperCron =>
  new OrphanPhotoSweeperCron(storage as unknown as R2StorageService);

describe('OrphanPhotoSweeperCron', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the schedule', () => {
    it('is 03:00 daily — asserted on the literal, because a typo is still valid cron', () => {
      // `'0 3 * * 0'` (Sundays) and `'0 3 1 * *'` (monthly) both parse without complaint, so
      // "it did not throw" proves nothing. Field by field: minute 0, hour 3, every day-of-month,
      // every month, every day-of-week.
      expect(ORPHAN_PHOTO_SWEEP_CRON).toBe('0 3 * * *');
      const [minute, hour, dayOfMonth, month, dayOfWeek] =
        ORPHAN_PHOTO_SWEEP_CRON.split(' ');
      expect({ minute, hour, dayOfMonth, month, dayOfWeek }).toEqual({
        minute: '0',
        hour: '3',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*',
      });
    });

    it('is the expression actually attached to the handler by @Cron', () => {
      // Reading the decorator's own metadata, so a future edit that changes the decorator argument
      // without changing the constant is caught. `SCHEDULE_CRON_OPTIONS` is @nestjs/schedule's key.
      //
      // Reached through the property DESCRIPTOR rather than `prototype.sweep`: the latter is an
      // unbound method reference, which `@typescript-eslint/unbound-method` rejects outright.
      const handler = Object.getOwnPropertyDescriptor(
        OrphanPhotoSweeperCron.prototype,
        'sweep',
      )?.value as object;
      const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler) as
        { cronTime?: unknown } | undefined;
      expect(options?.cronTime).toBe(ORPHAN_PHOTO_SWEEP_CRON);
    });
  });

  describe('the sweep', () => {
    it('asks for a 24h window — the same constant the manual CLI defaults to', async () => {
      const storage = makeStorage();
      await subject(storage).sweep();

      expect(storage.sweepStagedPhotos).toHaveBeenCalledTimes(1);
      expect(storage.sweepStagedPhotos).toHaveBeenCalledWith({
        olderThanMs: STAGED_PHOTO_MIN_AGE_MS,
      });
      // Spelled out as well as referenced: the constant is the safety floor, and a spec that only
      // compared it to itself would pass after somebody "tuned" it down to minutes.
      expect(STAGED_PHOTO_MIN_AGE_MS).toBe(86_400_000);
    });

    it('never passes dryRun — the scheduled run is the real one', async () => {
      const storage = makeStorage();
      await subject(storage).sweep();
      const [options] = storage.sweepStagedPhotos.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(options.dryRun).toBeUndefined();
    });

    it('logs the returned stats', async () => {
      const storage = makeStorage();
      await subject(storage).sweep();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('scanned=12 eligible=3 deleted=3'),
      );
    });

    it('SWALLOWS a throw and logs it — an escaped rejection out of a cron tick kills the process', async () => {
      const storage = makeStorage();
      storage.sweepStagedPhotos.mockRejectedValue(new Error('R2 is on fire'));

      await expect(subject(storage).sweep()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('R2 is on fire'),
      );
    });

    it('swallows a non-Error throw too', async () => {
      const storage = makeStorage();
      storage.sweepStagedPhotos.mockRejectedValue('just a string');

      await expect(subject(storage).sweep()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('just a string'),
      );
    });

    it('skips entirely when R2 is unconfigured, with one warning and no SDK call', async () => {
      const storage = makeStorage();
      storage.isConfigured.mockReturnValue(false);

      await subject(storage).sweep();

      expect(storage.sweepStagedPhotos).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('not configured'),
      );
    });
  });

  /**
   * ⚠️ THE ACTUAL PROOF FOR THIS TASK. `test/e2e-app.ts` boots the real `AppModule`, which reaches
   * `StorageModule` through both `AuthModule` and `VenuesModule`. If the job were registered under
   * test, every e2e suite would carry a live `CronJob` timer — an open handle that `jest
   * --detectOpenHandles` reports and that makes a green suite hang on exit.
   *
   * Asserted on the module's own decorator metadata rather than on the environment variables,
   * because the environment is the INPUT to the guard and this is about its OUTPUT.
   */
  describe('registration guard', () => {
    it('registers neither ScheduleModule nor the cron provider under test', () => {
      const imports = Reflect.getMetadata(
        'imports',
        StorageModule,
      ) as unknown[];
      const providers = Reflect.getMetadata(
        'providers',
        StorageModule,
      ) as unknown[];

      expect(imports).toEqual([]);
      expect(providers).not.toContain(OrphanPhotoSweeperCron);
    });

    it('confirms the two signals the guard reads are both present under jest', () => {
      // Measured, not assumed — the guard is only as good as these being true, and they are the
      // one thing about this file that a jest upgrade could silently change.
      expect(process.env.NODE_ENV).toBe('test');
      expect(process.env.JEST_WORKER_ID).toBeDefined();
    });
  });
});
