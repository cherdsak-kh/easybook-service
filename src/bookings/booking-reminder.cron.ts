import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BOOKING_REMINDER_LEAD_MINUTES,
  BookingNotifier,
} from './booking-notifier';

/** Every minute. Exported so the spec compares the decorator's metadata against it. */
export const BOOKING_REMINDER_CRON = CronExpression.EVERY_MINUTE;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `CLIENT-NOTIFY-1` — pushes the pre-usage reminder card (spec §3) to the owner of every APPROVED,
 * live slot that starts within the next {@link BOOKING_REMINDER_LEAD_MINUTES} minutes.
 *
 * ── 🔴 IDEMPOTENT BY A CLAIM, NOT BY A READ ──
 * `updateManyAndReturn` is ONE statement: `UPDATE booking_slots SET "reminderSentAt" = $now WHERE
 * "reminderSentAt" IS NULL AND … RETURNING id`. Only the RETURNING set is notified, and only after
 * the claim committed. A second tick, a restart, or a second app instance re-evaluates the guard under
 * the row lock and gets `[]`, so no slot is ever reminded twice. The trade-off is at-most-once: a push
 * that fails after the claim is logged and not retried.
 *
 * ⚠️ `startAt > now`: a slot that has already begun (downtime, or approved at the last second) is not
 * reminded — telling someone their booking "starts soon" after it started is wrong.
 * ⚠️ `lineUserId IS NOT NULL` is in the claim: a staff booking with no LINE owner has nobody to tell.
 * The opt-out (`reminders: false`) and unfollowed users are filtered by the notifier AFTER the claim,
 * so those slots are marked too and never re-read.
 *
 * Registered only when `SCHEDULING_ENABLED` (`common/scheduling.constants.ts`) — never under jest.
 */
@Injectable()
export class BookingReminderCron {
  private readonly logger = new Logger(BookingReminderCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: BookingNotifier,
  ) {}

  /** ⚠️ NOTHING MAY ESCAPE A CRON TICK — see `BookingExpiryCron.tick`. */
  @Cron(BOOKING_REMINDER_CRON, {
    name: 'booking-reminder',
    waitForCompletion: true,
  })
  async tick(): Promise<void> {
    try {
      await this.remindUpcoming();
    } catch (error: unknown) {
      this.logger.error(
        `Booking reminder tick failed after the claim; claimed slots are not retried. reason=${reasonOf(error)}`,
      );
    }
  }

  /** Returns the slot ids it claimed. Public so the spec and the e2e call it directly. */
  async remindUpcoming(now: Date = new Date()): Promise<string[]> {
    const horizon = new Date(
      now.getTime() + BOOKING_REMINDER_LEAD_MINUTES * 60_000,
    );

    let claimed: { id: string }[];
    try {
      claimed = await this.prisma.bookingSlot.updateManyAndReturn({
        where: {
          reminderSentAt: null,
          isCancelled: false,
          startAt: { gt: now, lte: horizon },
          bookingRequest: {
            status: BookingStatus.APPROVED,
            lineUserId: { not: null },
          },
        },
        data: { reminderSentAt: now },
        select: { id: true },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Booking reminder claim failed; nothing was written, the next tick retries. reason=${reasonOf(error)}`,
      );
      return [];
    }

    if (claimed.length === 0) return [];

    const ids = claimed.map((row) => row.id);
    // ⚠️ PII DISCIPLINE: count and slot ids only.
    this.logger.log(
      `Claimed ${ids.length} booking slot reminder(s). slots=${ids.join(',')}`,
    );

    // 🔴 AFTER THE CLAIM COMMITTED. Fail-soft inside.
    await this.notifier.notifyReminders(ids, now);
    return ids;
  }
}
