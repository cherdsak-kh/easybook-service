import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  BOOKING_REMINDER_LEAD_MINUTES,
  BookingNotifier,
} from './booking-notifier';
import {
  BOOKING_REMINDER_CRON,
  BookingReminderCron,
} from './booking-reminder.cron';
import { BookingsModule } from './bookings.module';
import { BookingsService } from './bookings.service';

/**
 * ⚠️ CONSTRUCTED BY HAND, never through `Test.createTestingModule`, and `ScheduleModule` is never
 * booted — same reasoning as `booking-expiry.cron.spec.ts`. The notifier is a stub: this file
 * measures the CLAIM (the idempotency boundary) and what is handed on after it.
 */

const NOW = new Date('2026-09-18T01:00:00.000Z');

describe('BookingReminderCron', () => {
  const updateManyAndReturn = jest.fn<Promise<{ id: string }[]>, [unknown]>();
  const prisma = {
    bookingSlot: { updateManyAndReturn },
  } as unknown as PrismaService;
  const notifyReminders = jest.fn<Promise<void>, [readonly string[], Date]>();
  const notifier = { notifyReminders } as unknown as BookingNotifier;

  const subject = () => new BookingReminderCron(prisma, notifier);

  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    updateManyAndReturn.mockReset();
    notifyReminders.mockReset();
    notifyReminders.mockResolvedValue(undefined);
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('the claim', () => {
    it('is ONE guarded update: unreminded, live, approved, LINE-owned slots starting within the hour', async () => {
      updateManyAndReturn.mockResolvedValue([]);

      await subject().remindUpcoming(NOW);

      expect(BOOKING_REMINDER_LEAD_MINUTES).toBe(60);
      expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
      // Exact equality: the WHERE is the idempotency guard, the data is the marker, ids only return.
      expect(updateManyAndReturn).toHaveBeenCalledWith({
        where: {
          reminderSentAt: null,
          isCancelled: false,
          startAt: {
            gt: NOW,
            lte: new Date(NOW.getTime() + 60 * 60_000),
          },
          bookingRequest: {
            status: BookingStatus.APPROVED,
            lineUserId: { not: null },
          },
        },
        data: { reminderSentAt: NOW },
        select: { id: true },
      });
    });

    it('takes `now` from the app clock when none is passed', async () => {
      updateManyAndReturn.mockResolvedValue([]);
      const before = Date.now();

      await subject().remindUpcoming();

      const after = Date.now();
      const [args] = updateManyAndReturn.mock.calls[0] as [
        { data: { reminderSentAt: Date } },
      ];
      const stamped = args.data.reminderSentAt.getTime();
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });
  });

  describe('the outcome', () => {
    it('N claimed: notifies exactly the RETURNING set, after the claim, with one log line', async () => {
      updateManyAndReturn.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

      await expect(subject().remindUpcoming(NOW)).resolves.toEqual([
        's1',
        's2',
      ]);

      expect(notifyReminders).toHaveBeenCalledTimes(1);
      expect(notifyReminders).toHaveBeenCalledWith(['s1', 's2'], NOW);
      expect(updateManyAndReturn.mock.invocationCallOrder[0]).toBeLessThan(
        notifyReminders.mock.invocationCallOrder[0],
      );
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = String((logSpy.mock.calls as unknown[][])[0][0]);
      expect(line).toContain('Claimed 2');
      expect(line).toContain('slots=s1,s2');
    });

    it('🔴 idempotent: a tick after the claim (or a second instance) gets [] and sends nothing', async () => {
      updateManyAndReturn
        .mockResolvedValueOnce([{ id: 's1' }])
        .mockResolvedValueOnce([]);
      const cron = subject();

      await cron.remindUpcoming(NOW);
      await expect(
        cron.remindUpcoming(new Date(NOW.getTime() + 60_000)),
      ).resolves.toEqual([]);

      expect(notifyReminders).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('a failed claim writes nothing: notifies nobody, logs an error, resolves []', async () => {
      updateManyAndReturn.mockRejectedValue(new Error('connection terminated'));

      await expect(subject().remindUpcoming(NOW)).resolves.toEqual([]);

      expect(notifyReminders).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('connection terminated'),
      );
    });
  });

  describe('tick', () => {
    it('runs the sweep', async () => {
      updateManyAndReturn.mockResolvedValue([{ id: 's1' }]);

      await subject().tick();

      expect(notifyReminders).toHaveBeenCalledTimes(1);
    });

    it('resolves cleanly when the notifier breaks its never-throw contract', async () => {
      updateManyAndReturn.mockResolvedValue([{ id: 's1' }]);
      notifyReminders.mockRejectedValue(new Error('line down'));

      await expect(subject().tick()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('line down'),
      );
    });

    it('is attached to @Cron every minute, with waitForCompletion', () => {
      const handler = Object.getOwnPropertyDescriptor(
        BookingReminderCron.prototype,
        'tick',
      )?.value as object;
      const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', handler) as
        { cronTime?: unknown; waitForCompletion?: unknown } | undefined;

      expect(BOOKING_REMINDER_CRON).toBe(CronExpression.EVERY_MINUTE);
      expect(options?.cronTime).toBe(CronExpression.EVERY_MINUTE);
      expect(options?.waitForCompletion).toBe(true);
    });
  });

  describe('registration', () => {
    it('BookingsModule provides the notifier but does not register the cron under jest', () => {
      const providers = Reflect.getMetadata(
        'providers',
        BookingsModule,
      ) as unknown[];

      // Positive control: the metadata read is real.
      expect(providers).toContain(BookingsService);
      expect(providers).toContain(BookingNotifier);
      expect(providers).not.toContain(BookingReminderCron);
    });
  });
});
