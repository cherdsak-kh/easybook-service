import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { toNotificationPreferences } from '../line/line-user.service';
import { LineService } from '../line/line.service';
import type {
  DecisionCardStatus,
  ReminderCardOptions,
} from '../line/notification-cards';
import { PrismaService } from '../prisma/prisma.service';
import { bookingCodeDatePart } from './booking-code';
import {
  BANGKOK_UTC_OFFSET_MINUTES,
  BUDDHIST_ERA_OFFSET,
} from './bookings.constants';

/**
 * How far ahead of a slot's start `BookingReminderCron` reminds its owner (spec §3: "1 ชั่วโมง").
 * One reminder per slot; see `BookingSlot.reminderSentAt`.
 */
export const BOOKING_REMINDER_LEAD_MINUTES = 60;

/**
 * Above this many minutes to go, the card says "1 ชั่วโมง"; at or below it, "30 นาที". The spec's
 * type allows only those two phrases, so a slot approved inside the hour is rounded to the nearer.
 */
const REMINDER_LEAD_SPLIT_MINUTES = 45;

const THAI_MONTHS_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
] as const;

/** Shifted into Bangkok's frame to READ calendar fields — never stored (see `booking-code.ts`). */
const bangkok = (at: Date): Date =>
  new Date(at.getTime() + BANGKOK_UTC_OFFSET_MINUTES * 60_000);

/** `2026-09-18T02:00:00Z` → `"18 ก.ย. 2569"` (Bangkok calendar, Buddhist era). */
export function thaiShortDate(at: Date): string {
  const local = bangkok(at);
  return `${local.getUTCDate()} ${THAI_MONTHS_SHORT[local.getUTCMonth()]} ${
    local.getUTCFullYear() + BUDDHIST_ERA_OFFSET
  }`;
}

/** `2026-09-18T02:00:00Z` → `"09:00"` (Bangkok wall clock). */
export function bangkokClock(at: Date): string {
  const local = bangkok(at);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface SlotTimes {
  startAt: Date;
  endAt: Date;
}

/**
 * The card's `วันที่ใช้งาน` / `ช่วงเวลา` pair for a set of slots.
 *
 * One slot → `"18 ก.ย. 2569"` / `"09:00 - 12:00 น."`. Several slots → the date RANGE with a count
 * (so Mon + Wed never reads as Mon–Wed without saying there are two), and one period when every
 * slot shares it, else `"หลายช่วงเวลา"`. LINE rejects an empty text node, hence the `-` fallback.
 */
export function describeSlots(slots: readonly SlotTimes[]): {
  dateText: string;
  periodText: string;
} {
  if (slots.length === 0) return { dateText: '-', periodText: '-' };
  const first = thaiShortDate(
    new Date(Math.min(...slots.map((s) => s.startAt.getTime()))),
  );
  // `- 1` ms: a slot ending exactly at midnight belongs to the day it started on.
  const last = thaiShortDate(
    new Date(Math.max(...slots.map((s) => s.endAt.getTime())) - 1),
  );
  let dateText = first === last ? first : `${first} - ${last}`;
  if (slots.length > 1) dateText += ` (${slots.length} ช่วงเวลา)`;

  const periods = new Set(
    slots.map((s) => `${bangkokClock(s.startAt)} - ${bangkokClock(s.endAt)}`),
  );
  const periodText =
    periods.size === 1 ? `${[...periods][0]} น.` : 'หลายช่วงเวลา';
  return { dateText, periodText };
}

/** `"1 ชั่วโมง"` or `"30 นาที"`, from how long is actually left. */
export function reminderLeadText(
  startAt: Date,
  now: Date,
): ReminderCardOptions['leadTimeText'] {
  return startAt.getTime() - now.getTime() >
    REMINDER_LEAD_SPLIT_MINUTES * 60_000
    ? '1 ชั่วโมง'
    : '30 นาที';
}

/** Spec §3 wireframe: `"วันนี้ (18 ก.ย. 2569)"` when the slot starts on today's Bangkok date. */
export function reminderDateText(startAt: Date, now: Date): string {
  const date = thaiShortDate(startAt);
  return bookingCodeDatePart(startAt) === bookingCodeDatePart(now)
    ? `วันนี้ (${date})`
    : date;
}

/** One status change to tell a booking's owner about. */
export interface DecisionNotice {
  bookingId: string;
  status: DecisionCardStatus;
  /**
   * The operator's reason — `REJECTED` / `CANCELLED_BY_STAFF` only.
   * 🔴 Never set for `AUTO_REJECTED` (D-C13); the card builder ignores it there regardless.
   */
  reason?: string;
  /** The slots the notice is ABOUT (a partial cancellation). Default: live slots, else all. */
  slotIds?: readonly string[];
}

const RECIPIENT_SELECT = {
  lineUserId: true,
  deletedAt: true,
  settings: { select: { notifications: true } },
} satisfies Prisma.LineUserSelect;

type Recipient = Prisma.LineUserGetPayload<{
  select: typeof RECIPIENT_SELECT;
}>;

/**
 * What a decision card needs, in ONE read for every notice of a write (never one query per id).
 *
 * ⚠️ `rejectReason` IS DELIBERATELY NOT SELECTED. The only reason a card shows is the one the calling
 * write passes in explicitly, so an auto-rejection's stored text has no path into a message.
 */
const DECISION_SELECT = {
  id: true,
  code: true,
  purpose: true,
  attendees: true,
  venueId: true,
  venue: { select: { name: true, location: true } },
  lineUser: { select: RECIPIENT_SELECT },
  slots: {
    select: { id: true, startAt: true, endAt: true, isCancelled: true },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.BookingRequestSelect;

type DecisionRow = Prisma.BookingRequestGetPayload<{
  select: typeof DECISION_SELECT;
}>;

const REMINDER_SELECT = {
  id: true,
  startAt: true,
  endAt: true,
  bookingRequest: {
    select: {
      code: true,
      purpose: true,
      attendees: true,
      venue: { select: { name: true, location: true } },
      lineUser: { select: RECIPIENT_SELECT },
    },
  },
} satisfies Prisma.BookingSlotSelect;

type ReminderRow = Prisma.BookingSlotGetPayload<{
  select: typeof REMINDER_SELECT;
}>;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The LINE `U…` id to push to, or `null` when this person must not be messaged: no LINE owner (a
 * staff booking), unfollowed (soft-deleted — the push would fail anyway), or the category switched
 * off in `LineUserSettings.notifications` (spec §5; a missing row means the defaults, all on).
 */
function recipientOf(
  user: Recipient | null,
  category: 'decisions' | 'reminders',
): string | null {
  if (!user || user.deletedAt) return null;
  return toNotificationPreferences(user.settings?.notifications)[category]
    ? user.lineUserId
    : null;
}

function pickSlots(
  slots: DecisionRow['slots'],
  slotIds: readonly string[] | undefined,
): DecisionRow['slots'] {
  if (slotIds && slotIds.length > 0) {
    const wanted = new Set(slotIds);
    const picked = slots.filter((s) => wanted.has(s.id));
    if (picked.length > 0) return picked;
  }
  const live = slots.filter((s) => !s.isCancelled);
  return live.length > 0 ? live : slots;
}

/**
 * `CLIENT-NOTIFY-1` — sends the booking Flex cards (`src/line/notification-cards.ts`) to the LINE user
 * who owns a booking.
 *
 * 🔴 FAIL-SOFT AND AFTER THE COMMIT, the same discipline as `publishBookingRequests` and
 * `LineUserService.notifyAccessChange`: callers invoke it only once their write has committed, and
 * it NEVER throws or rejects. A LINE outage, a blocked OA or a failed read is a `warn` carrying the
 * booking/slot id and status only — never a purpose, reason, name or LINE id — and can never fail or
 * roll back the booking mutation.
 *
 * Takes `PrismaService`, not a transaction client, for the same compile-time reason the realtime
 * dispatcher does.
 */
@Injectable()
export class BookingNotifier {
  private readonly logger = new Logger(BookingNotifier.name);

  /** `LINE_LIFF_URL`, or `null` — unset hides the CTA footer (spec §1.5 Fail-soft CTA). */
  private readonly liffUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
    config: ConfigService,
  ) {
    this.liffUrl = config.get<string>('LINE_LIFF_URL') ?? null;
  }

  /** One card per notice, to each booking's owner, gated on their `decisions` preference. */
  async notifyDecisions(notices: readonly DecisionNotice[]): Promise<void> {
    if (notices.length === 0) return;
    const ids = [...new Set(notices.map((n) => n.bookingId))];

    let rows: DecisionRow[];
    try {
      rows = await this.prisma.bookingRequest.findMany({
        where: { id: { in: ids }, lineUserId: { not: null } },
        select: DECISION_SELECT,
      });
    } catch (error) {
      this.logger.warn(
        `LINE booking notification read failed (write already committed). ids=${ids.join(',')}: ${reasonOf(error)}`,
      );
      return;
    }

    const byId = new Map(rows.map((row) => [row.id, row] as const));
    await Promise.all(
      notices.map((notice) =>
        this.sendDecision(notice, byId.get(notice.bookingId)),
      ),
    );
  }

  /** One reminder per claimed slot, gated on the owner's `reminders` preference. */
  async notifyReminders(slotIds: readonly string[], now: Date): Promise<void> {
    if (slotIds.length === 0) return;

    let rows: ReminderRow[];
    try {
      rows = await this.prisma.bookingSlot.findMany({
        where: { id: { in: [...slotIds] } },
        select: REMINDER_SELECT,
      });
    } catch (error) {
      this.logger.warn(
        `LINE reminder read failed (reminders already claimed). slots=${slotIds.join(',')}: ${reasonOf(error)}`,
      );
      return;
    }

    await Promise.all(rows.map((row) => this.sendReminder(row, now)));
  }

  private async sendDecision(
    notice: DecisionNotice,
    row: DecisionRow | undefined,
  ): Promise<void> {
    try {
      if (!row) return;
      const to = recipientOf(row.lineUser, 'decisions');
      if (!to) return;

      await this.line.pushDecisionNotification(to, {
        status: notice.status,
        bookingCode: row.code,
        purpose: row.purpose,
        attendees: row.attendees,
        venueName: row.venue.name,
        venueLocation: row.venue.location ?? undefined,
        ...describeSlots(pickSlots(row.slots, notice.slotIds)),
        // 🔴 D-C13: an auto-rejection never forwards a reason, even if a caller supplied one.
        reason: notice.status === 'AUTO_REJECTED' ? undefined : notice.reason,
        bookingId: row.id,
        venueId: row.venueId,
        liffUrl: this.liffUrl,
      });
    } catch (error) {
      this.logger.warn(
        `Best-effort LINE booking notification failed (status change already persisted). booking=${notice.bookingId} status=${notice.status}: ${reasonOf(error)}`,
      );
    }
  }

  private async sendReminder(row: ReminderRow, now: Date): Promise<void> {
    try {
      const booking = row.bookingRequest;
      const to = recipientOf(booking.lineUser, 'reminders');
      if (!to) return;

      await this.line.pushReminderNotification(to, {
        leadTimeText: reminderLeadText(row.startAt, now),
        bookingCode: booking.code,
        purpose: booking.purpose,
        attendees: booking.attendees,
        venueName: booking.venue.name,
        venueLocation: booking.venue.location ?? undefined,
        dateText: reminderDateText(row.startAt, now),
        periodText: `${bangkokClock(row.startAt)} - ${bangkokClock(row.endAt)} น.`,
      });
    } catch (error) {
      this.logger.warn(
        `Best-effort LINE reminder failed (reminder already claimed, not retried). slot=${row.id}: ${reasonOf(error)}`,
      );
    }
  }
}
