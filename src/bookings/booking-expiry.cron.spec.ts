import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CronExpression, ScheduleModule } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { AppModule } from '../app.module';
import { schedulingEnabled } from '../common/scheduling.constants';
import type { PrismaService } from '../prisma/prisma.service';
import type { ClientRealtimeGateway } from '../realtime/client-realtime.gateway';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import { BOOKING_EXPIRY_CRON, BookingExpiryCron } from './booking-expiry.cron';
import { publishBookingRequests } from './booking-realtime';
import {
  AUTO_EXPIRED_REASON,
  BOOKING_EXPIRY_PUBLISH_CHUNK,
} from './bookings.constants';
import { BookingsModule } from './bookings.module';
import { BookingsService } from './bookings.service';

/**
 * ⚠️ THE SUBJECT IS CONSTRUCTED BY HAND, never through `Test.createTestingModule`, and
 * `ScheduleModule` is never booted: a registered `CronJob` is an open handle in a suite whose point
 * is that none exists. Prisma and both gateways are stubs; the fan-out is mocked at the module seam
 * so this file measures WHICH ids the cron announces, not how the gateways deliver them.
 */
jest.mock('./booking-realtime');

const publish = jest.mocked(publishBookingRequests);

/** Copied from `01_plan_log.md` Slice 8 (AC-8.1), never retyped. */
const PLAN_REASON =
  'คำขอหมดอายุโดยอัตโนมัติ เนื่องจากเลยกำหนดเวลาเริ่มต้นใช้งานโดยยังไม่ได้รับการพิจารณา';

const NOW = new Date('2026-09-14T03:00:00.000Z');

const ids = (n: number) => Array.from({ length: n }, (_, i) => `br-${i}`);

/** `{ module: ScheduleModule }` from `forRoot()`, or the bare class — either is a registration. */
const isScheduleModule = (entry: unknown): boolean =>
  entry === ScheduleModule ||
  (entry as { module?: unknown } | null)?.module === ScheduleModule;

describe('BookingExpiryCron', () => {
  const updateManyAndReturn = jest.fn<Promise<{ id: string }[]>, [unknown]>();
  const prisma = {
    bookingRequest: { updateManyAndReturn },
  } as unknown as PrismaService;
  const realtime = { name: 'admin-gateway' } as unknown as RealtimeGateway;
  const client = { name: 'client-gateway' } as unknown as ClientRealtimeGateway;

  const subject = () => new BookingExpiryCron(prisma, realtime, client);

  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    updateManyAndReturn.mockReset();
    publish.mockReset();
    publish.mockResolvedValue(undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('the statement (AC-8.1)', () => {
    it('is ONE guarded update: stored PENDING whose first slot started before now', async () => {
      updateManyAndReturn.mockResolvedValue([]);

      await subject().expireOverdue(NOW);

      expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
      // Exact equality: no `lastEndAt` threshold, no extra columns touched, only ids returned.
      expect(updateManyAndReturn).toHaveBeenCalledWith({
        where: { status: BookingStatus.PENDING, firstStartAt: { lt: NOW } },
        data: {
          status: BookingStatus.EXPIRED,
          rejectReason: AUTO_EXPIRED_REASON,
        },
        select: { id: true },
      });
    });

    it('takes `now` from the app clock when none is passed', async () => {
      updateManyAndReturn.mockResolvedValue([]);
      const before = Date.now();

      await subject().expireOverdue();

      const after = Date.now();
      const [args] = updateManyAndReturn.mock.calls[0] as [
        { where: { firstStartAt: { lt: Date } } },
      ];
      const lt = args.where.firstStartAt.lt.getTime();
      expect(lt).toBeGreaterThanOrEqual(before);
      expect(lt).toBeLessThanOrEqual(after);
    });

    it('writes the reason byte-equal to the plan’s Thai string', () => {
      expect(AUTO_EXPIRED_REASON).toBe(PLAN_REASON);
      expect(Buffer.from(AUTO_EXPIRED_REASON, 'utf8')).toEqual(
        Buffer.from(PLAN_REASON, 'utf8'),
      );
    });
  });

  describe('the outcome', () => {
    it('zero rows: publishes nothing, logs nothing, returns [] (AC-8.2)', async () => {
      updateManyAndReturn.mockResolvedValue([]);

      await expect(subject().expireOverdue(NOW)).resolves.toEqual([]);

      expect(publish).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('N rows: ONE `updated` publish after the write, system actor null, one log line', async () => {
      updateManyAndReturn.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

      await expect(subject().expireOverdue(NOW)).resolves.toEqual(['a', 'b']);

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        prisma,
        realtime,
        client,
        'updated',
        ['a', 'b'],
        null,
      );
      expect(updateManyAndReturn.mock.invocationCallOrder[0]).toBeLessThan(
        publish.mock.invocationCallOrder[0],
      );
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = String((logSpy.mock.calls as unknown[][])[0][0]);
      expect(line).toContain('Expired 2');
      expect(line).toContain('ids=a,b');
    });

    it('a failed update writes nothing: publishes nothing, logs an error, resolves [] (AC-8.2)', async () => {
      updateManyAndReturn.mockRejectedValue(new Error('connection terminated'));

      await expect(subject().expireOverdue(NOW)).resolves.toEqual([]);

      expect(publish).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection terminated'),
      );
    });

    it('publishes exactly the RETURNING set — a row decided meanwhile is not announced (AC-8.3)', async () => {
      // Three rows "looked" overdue; an operator approved `a` and `c` first, so the guarded
      // statement returned only `b`. There is no prior read that could re-introduce them.
      updateManyAndReturn.mockResolvedValue([{ id: 'b' }]);

      await expect(subject().expireOverdue(NOW)).resolves.toEqual(['b']);

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][4]).toEqual(['b']);
    });

    it('a second instance that lost the race publishes nothing', async () => {
      updateManyAndReturn.mockResolvedValue([]);

      await subject().expireOverdue(NOW);

      expect(publish).not.toHaveBeenCalled();
    });

    it('chunks a backlog publish at 500 ids, in order, without capping the write', async () => {
      expect(BOOKING_EXPIRY_PUBLISH_CHUNK).toBe(500);
      const all = ids(1201);
      updateManyAndReturn.mockResolvedValue(all.map((id) => ({ id })));

      await expect(subject().expireOverdue(NOW)).resolves.toEqual(all);

      expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
      const chunks = publish.mock.calls.map((call) => call[4]);
      expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 201]);
      expect(chunks.flat()).toEqual(all);
    });
  });

  describe('tick', () => {
    it('runs the sweep', async () => {
      updateManyAndReturn.mockResolvedValue([{ id: 'a' }]);

      await subject().tick();

      expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    /**
     * ⚠️ AN ESCAPED REJECTION OUT OF A CRON TICK TERMINATES NODE 20+. `publishBookingRequests` is
     * fail-soft by contract; this proves the tick survives even if that contract is ever broken.
     */
    it('resolves cleanly when the publish throws, and logs it', async () => {
      updateManyAndReturn.mockResolvedValue([{ id: 'a' }]);
      publish.mockRejectedValue(new Error('transport down'));

      await expect(subject().tick()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('transport down'),
      );
    });

    it('resolves cleanly when the update throws', async () => {
      updateManyAndReturn.mockRejectedValue('not even an Error');

      await expect(subject().tick()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('not even an Error'),
      );
    });

    it('is attached to @Cron every minute, with waitForCompletion', () => {
      // Read through the property DESCRIPTOR: `prototype.tick` is an unbound method reference, which
      // `@typescript-eslint/unbound-method` rejects. `SCHEDULE_CRON_OPTIONS` is @nestjs/schedule's key.
      const handler = Object.getOwnPropertyDescriptor(
        BookingExpiryCron.prototype,
        'tick',
      )?.value as object;
      const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler) as
        { cronTime?: unknown; waitForCompletion?: unknown } | undefined;

      expect(BOOKING_EXPIRY_CRON).toBe(CronExpression.EVERY_MINUTE);
      expect(options?.cronTime).toBe(CronExpression.EVERY_MINUTE);
      expect(options?.waitForCompletion).toBe(true);
    });
  });

  /**
   * ⚠️ AC-8.10. `test/e2e-app.ts` boots the real `AppModule`; a registered scheduler or cron provider
   * would be a live `CronJob` timer in every e2e suite. Asserted on decorator metadata — the OUTPUT of
   * the guard — and then on the pure function that computes it.
   */
  describe('registration guard (AC-8.10)', () => {
    it('BookingsModule does not register BookingExpiryCron under jest', () => {
      const providers = Reflect.getMetadata(
        'providers',
        BookingsModule,
      ) as unknown[];

      // Positive control: the metadata read is real, not an empty array by accident.
      expect(providers).toContain(BookingsService);
      expect(providers).not.toContain(BookingExpiryCron);
    });

    it('AppModule does not import ScheduleModule under jest', () => {
      const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

      // Positive control: the matcher does recognise a `forRoot()` registration.
      expect(isScheduleModule(ScheduleModule.forRoot())).toBe(true);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.some(isScheduleModule)).toBe(false);
    });

    it.each([
      [{ NODE_ENV: 'test' }, false],
      [{ JEST_WORKER_ID: '1' }, false],
      [{ NODE_ENV: 'test ', JEST_WORKER_ID: '1' }, false],
      [{ NODE_ENV: 'production' }, true],
      [{ NODE_ENV: 'development' }, true],
      [{}, true],
    ])('schedulingEnabled(%j) is %s', (env, expected) => {
      expect(schedulingEnabled(env)).toBe(expected);
    });

    it('confirms the two signals the guard reads are both present under jest', () => {
      expect(process.env.NODE_ENV).toBe('test');
      expect(process.env.JEST_WORKER_ID).toBeDefined();
    });
  });
});
