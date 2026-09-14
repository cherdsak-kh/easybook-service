import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClientRealtimeGateway } from '../realtime/client-realtime.gateway';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { publishBookingRequests } from './booking-realtime';
import {
  AUTO_EXPIRED_REASON,
  BOOKING_EXPIRY_PUBLISH_CHUNK,
} from './bookings.constants';

/** Every minute. Exported so the spec compares the decorator's metadata against it. */
export const BOOKING_EXPIRY_CRON = CronExpression.EVERY_MINUTE;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Flips overdue `PENDING` requests to the stored `EXPIRED` (#ISSUE-06, superseding D-C13's
 * "no stored EXPIRED / no cron" clause).
 *
 * 🔴 THE ONLY DEFINITION OF "EXPIRED". Nothing computes expiry at read time: a request past its
 * `firstStartAt` that this job has not reached yet IS still `PENDING` (accepted gap: one tick).
 *
 * ── ONE SET-BASED STATEMENT, NOT SELECT-THEN-UPDATE ──
 * `updateManyAndReturn` compiles to a single `UPDATE … WHERE status = 'PENDING' AND "firstStartAt" <
 * $now RETURNING id`. A single statement is its own transaction, so N rows flip together or not at
 * all. The `WHERE` *is* the race guard: a row an operator approved, rejected or cancelled first is
 * re-evaluated under the row lock and skipped, and a second app instance ticking at the same moment
 * gets `[]`. The published set is always the `RETURNING` set, never a prior read.
 *
 * ⚠️ NO ROW CAP PER TICK. A downtime backlog is swept in one statement; only the PUBLISH is chunked.
 * ⚠️ NO VENUE ADVISORY LOCK. Expiry never creates a hold (the `holdsSlot` triggers test `APPROVED`
 * only), so there is nothing to serialise against `BOOKING_VENUE_LOCK_NS`.
 *
 * Registered only when `SCHEDULING_ENABLED` (`common/scheduling.constants.ts`) — never under jest.
 */
@Injectable()
export class BookingExpiryCron {
  private readonly logger = new Logger(BookingExpiryCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly client: ClientRealtimeGateway,
  ) {}

  /**
   * ⚠️ NOTHING MAY ESCAPE THIS METHOD. An unhandled rejection out of a `CronJob` tick has no request
   * to fail — Node 20+ terminates the process on it. `expireOverdue` already contains its own write
   * failure and the publish is fail-soft by contract; this catch is the last line, so that even a
   * publish that broke its contract costs one logged tick rather than the server.
   *
   * `waitForCompletion` stops a slow tick overlapping the next one in the same process. Correctness
   * does not depend on it (see the class note); it only avoids wasted work.
   */
  @Cron(BOOKING_EXPIRY_CRON, {
    name: 'booking-expiry',
    waitForCompletion: true,
  })
  async tick(): Promise<void> {
    try {
      await this.expireOverdue();
    } catch (error: unknown) {
      this.logger.error(
        `Booking expiry tick failed after the write; the expired rows stay expired. reason=${reasonOf(error)}`,
      );
    }
  }

  /**
   * Returns the ids it expired. Public so the spec and the e2e call it directly — the cron itself is
   * not registered under jest.
   *
   * `now` is taken once, from the app clock — the same clock `SLOT_IN_THE_PAST` uses.
   */
  async expireOverdue(now: Date = new Date()): Promise<string[]> {
    let expired: { id: string }[];
    try {
      expired = await this.prisma.bookingRequest.updateManyAndReturn({
        where: { status: BookingStatus.PENDING, firstStartAt: { lt: now } },
        data: {
          status: BookingStatus.EXPIRED,
          rejectReason: AUTO_EXPIRED_REASON,
        },
        select: { id: true },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Booking expiry sweep failed; nothing was written, the next tick retries. reason=${reasonOf(error)}`,
      );
      return [];
    }

    // A zero-row tick wrote nothing, so it logs nothing and announces nothing — 1,440 empty lines a
    // day would bury the ticks that did something.
    if (expired.length === 0) return [];

    const ids = expired.map((row) => row.id);
    // ⚠️ PII DISCIPLINE: count and ids only. Purpose, requester and reason never reach a log.
    this.logger.log(
      `Expired ${ids.length} overdue pending booking request(s). ids=${ids.join(',')}`,
    );

    // 🔴 AFTER THE COMMIT — the statement above has already committed. `PrismaService`, never a
    // transaction client (the compile-time form of that rule). `actor: null` is the system: nobody
    // on staff operated, and inventing a `{ id: 'system' }` actor would be a third producer of a shape
    // that names a colleague. Chunked so one re-read's `IN` list stays bounded on a backlog.
    for (let i = 0; i < ids.length; i += BOOKING_EXPIRY_PUBLISH_CHUNK) {
      await publishBookingRequests(
        this.prisma,
        this.realtime,
        this.client,
        'updated',
        ids.slice(i, i + BOOKING_EXPIRY_PUBLISH_CHUNK),
        null,
      );
    }
    return ids;
  }
}
