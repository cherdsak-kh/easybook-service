import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { LineService } from '../line/line.service';
import type {
  DecisionCardOptions,
  ReminderCardOptions,
} from '../line/notification-cards';
import type { PrismaService } from '../prisma/prisma.service';
import {
  BOOKING_REMINDER_LEAD_MINUTES,
  BookingNotifier,
  bangkokClock,
  describeSlots,
  reminderDateText,
  reminderLeadText,
  thaiShortDate,
} from './booking-notifier';

/**
 * The notifier is constructed by hand over stubbed Prisma / LINE / config. What this file measures:
 * who gets messaged, with which options, from how many reads — and that nothing ever escapes.
 * The card JSON itself is `notification-cards.spec.ts`'s job.
 */

const LIFF = 'https://liff.line.me/1234567890-abcdefgh';
const MIN = 60_000;

/** 09:00–12:00 on 18 Sep 2026, Bangkok. */
const START = new Date('2026-09-18T02:00:00.000Z');
const END = new Date('2026-09-18T05:00:00.000Z');

const decisionRow = (over: Record<string, unknown> = {}) => ({
  id: 'bk1',
  code: 'BR-25690918-001',
  purpose: 'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
  attendees: 50,
  venueId: 'vn1',
  venue: { name: 'ห้องประชุมใหญ่', location: null as string | null },
  lineUser: {
    lineUserId: 'U-owner',
    deletedAt: null as Date | null,
    settings: null as { notifications: unknown } | null,
  },
  slots: [{ id: 's1', startAt: START, endAt: END, isCancelled: false }],
  ...over,
});

describe('formatting helpers', () => {
  it('renders the Bangkok calendar date in the Buddhist era, Thai short month', () => {
    expect(thaiShortDate(START)).toBe('18 ก.ย. 2569');
    // 00:30 on the 18th in Bangkok is still the 17th in UTC.
    expect(thaiShortDate(new Date('2026-09-17T17:30:00.000Z'))).toBe(
      '18 ก.ย. 2569',
    );
    expect(bangkokClock(new Date('2026-09-17T17:30:00.000Z'))).toBe('00:30');
  });

  it('one slot → its date and "HH:mm - HH:mm น."', () => {
    expect(describeSlots([{ startAt: START, endAt: END }])).toEqual({
      dateText: '18 ก.ย. 2569',
      periodText: '09:00 - 12:00 น.',
    });
  });

  it('a slot ending exactly at Bangkok midnight belongs to the day it started', () => {
    expect(
      describeSlots([
        {
          startAt: new Date('2026-09-18T15:00:00.000Z'),
          endAt: new Date('2026-09-18T17:00:00.000Z'),
        },
      ]),
    ).toEqual({ dateText: '18 ก.ย. 2569', periodText: '22:00 - 00:00 น.' });
  });

  it('several days at the same time → a counted range and the shared period', () => {
    const day = 86_400_000;
    const slots = [0, 1, 2].map((d) => ({
      startAt: new Date(START.getTime() + d * day),
      endAt: new Date(END.getTime() + d * day),
    }));

    expect(describeSlots(slots)).toEqual({
      dateText: '18 ก.ย. 2569 - 20 ก.ย. 2569 (3 ช่วงเวลา)',
      periodText: '09:00 - 12:00 น.',
    });
  });

  it('different periods → "หลายช่วงเวลา"; no slots → "-" (LINE refuses empty text)', () => {
    expect(
      describeSlots([
        { startAt: START, endAt: END },
        {
          startAt: new Date('2026-09-18T07:00:00.000Z'),
          endAt: new Date('2026-09-18T08:00:00.000Z'),
        },
      ]),
    ).toEqual({
      dateText: '18 ก.ย. 2569 (2 ช่วงเวลา)',
      periodText: 'หลายช่วงเวลา',
    });
    expect(describeSlots([])).toEqual({ dateText: '-', periodText: '-' });
  });

  it.each([
    [60, '1 ชั่วโมง'],
    [46, '1 ชั่วโมง'],
    [45, '30 นาที'],
    [10, '30 นาที'],
  ] as [number, string][])(
    '%i minutes to go reads "%s"',
    (minutes, expected) => {
      const now = new Date(START.getTime() - minutes * MIN);
      expect(reminderLeadText(START, now)).toBe(expected);
    },
  );

  it('prefixes "วันนี้" only when the slot starts on today’s Bangkok date', () => {
    expect(reminderDateText(START, new Date(START.getTime() - 60 * MIN))).toBe(
      'วันนี้ (18 ก.ย. 2569)',
    );
    // 00:30 Bangkok slot, reminded at 23:30 the evening before.
    const pastMidnight = new Date('2026-09-17T17:30:00.000Z');
    expect(
      reminderDateText(
        pastMidnight,
        new Date(pastMidnight.getTime() - 60 * MIN),
      ),
    ).toBe('18 ก.ย. 2569');
  });

  it('reminds one hour ahead', () => {
    expect(BOOKING_REMINDER_LEAD_MINUTES).toBe(60);
  });
});

describe('BookingNotifier', () => {
  const bookingFindMany = jest.fn<Promise<unknown[]>, [unknown]>();
  const slotFindMany = jest.fn<Promise<unknown[]>, [unknown]>();
  const prisma = {
    bookingRequest: { findMany: bookingFindMany },
    bookingSlot: { findMany: slotFindMany },
  } as unknown as PrismaService;

  const pushDecision = jest.fn<
    Promise<unknown>,
    [string, DecisionCardOptions]
  >();
  const pushReminder = jest.fn<
    Promise<unknown>,
    [string, ReminderCardOptions]
  >();
  const line = {
    pushDecisionNotification: pushDecision,
    pushReminderNotification: pushReminder,
  } as unknown as LineService;

  /** `null` = the variable is unset (`ConfigService.get` answers `undefined`). */
  const configWith = (liff: string | null) =>
    ({ get: jest.fn(() => liff ?? undefined) }) as unknown as ConfigService;

  const subject = (liff: string | null = LIFF) =>
    new BookingNotifier(prisma, line, configWith(liff));

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    bookingFindMany.mockReset();
    slotFindMany.mockReset();
    pushDecision.mockReset();
    pushReminder.mockReset();
    pushDecision.mockResolvedValue({});
    pushReminder.mockResolvedValue({});
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => warnSpy.mockRestore());

  const warnings = () =>
    (warnSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');

  describe('notifyDecisions', () => {
    it('reads every notice’s booking in ONE query, LINE-owned rows only, and never selects rejectReason', async () => {
      bookingFindMany.mockResolvedValue([]);

      await subject().notifyDecisions([
        { bookingId: 'a', status: 'APPROVED' },
        { bookingId: 'b', status: 'AUTO_REJECTED' },
        { bookingId: 'c', status: 'AUTO_REJECTED' },
      ]);

      expect(bookingFindMany).toHaveBeenCalledTimes(1);
      const args = bookingFindMany.mock.calls[0][0] as {
        where: unknown;
        select: Record<string, unknown>;
      };
      expect(args.where).toEqual({
        id: { in: ['a', 'b', 'c'] },
        lineUserId: { not: null },
      });
      // 🔴 D-C13: the stored auto-reject text has no path into a message.
      expect(args.select).not.toHaveProperty('rejectReason');
    });

    it('does nothing at all for an empty batch', async () => {
      await subject().notifyDecisions([]);

      expect(bookingFindMany).not.toHaveBeenCalled();
    });

    it('pushes the card options to the owner’s LINE id', async () => {
      bookingFindMany.mockResolvedValue([
        decisionRow({
          venue: { name: 'ห้องประชุมใหญ่', location: 'ชั้น 3' },
        }),
      ]);

      await subject().notifyDecisions([
        { bookingId: 'bk1', status: 'REJECTED', reason: 'ปิดปรับปรุง' },
      ]);

      expect(pushDecision).toHaveBeenCalledTimes(1);
      expect(pushDecision).toHaveBeenCalledWith('U-owner', {
        status: 'REJECTED',
        bookingCode: 'BR-25690918-001',
        purpose: 'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
        attendees: 50,
        venueName: 'ห้องประชุมใหญ่',
        venueLocation: 'ชั้น 3',
        dateText: '18 ก.ย. 2569',
        periodText: '09:00 - 12:00 น.',
        reason: 'ปิดปรับปรุง',
        bookingId: 'bk1',
        venueId: 'vn1',
        liffUrl: LIFF,
      });
    });

    it('🔴 D-C13 — never forwards a reason on AUTO_REJECTED, even if a caller passed one', async () => {
      bookingFindMany.mockResolvedValue([decisionRow()]);

      await subject().notifyDecisions([
        { bookingId: 'bk1', status: 'AUTO_REJECTED', reason: 'ชนะโดยนาย ก.' },
      ]);

      expect(pushDecision.mock.calls[0][1].reason).toBeUndefined();
      expect(JSON.stringify(pushDecision.mock.calls)).not.toContain('นาย ก.');
    });

    it('passes liffUrl null when LINE_LIFF_URL is unset, so the card hides its CTA', async () => {
      bookingFindMany.mockResolvedValue([decisionRow()]);

      await subject(null).notifyDecisions([
        { bookingId: 'bk1', status: 'APPROVED' },
      ]);

      expect(pushDecision.mock.calls[0][1].liffUrl).toBeNull();
    });

    it.each([
      [
        'an unfollowed (soft-deleted) user',
        {
          lineUser: {
            lineUserId: 'U-owner',
            deletedAt: new Date(),
            settings: null,
          },
        },
      ],
      [
        'a user who switched decisions off',
        {
          lineUser: {
            lineUserId: 'U-owner',
            deletedAt: null,
            settings: {
              notifications: {
                announcements: true,
                decisions: false,
                reminders: true,
              },
            },
          },
        },
      ],
      ['a booking with no LINE owner', { lineUser: null }],
    ])('skips %s', async (_label, over) => {
      bookingFindMany.mockResolvedValue([decisionRow(over)]);

      await subject().notifyDecisions([
        { bookingId: 'bk1', status: 'APPROVED' },
      ]);

      expect(pushDecision).not.toHaveBeenCalled();
    });

    it('still sends decisions to a user who only switched reminders off, or whose settings JSON is malformed', async () => {
      bookingFindMany.mockResolvedValue([
        decisionRow({
          lineUser: {
            lineUserId: 'U-a',
            deletedAt: null,
            settings: { notifications: { reminders: false } },
          },
        }),
        decisionRow({
          id: 'bk2',
          lineUser: {
            lineUserId: 'U-b',
            deletedAt: null,
            settings: { notifications: { decisions: 'yes' } },
          },
        }),
      ]);

      await subject().notifyDecisions([
        { bookingId: 'bk1', status: 'APPROVED' },
        { bookingId: 'bk2', status: 'APPROVED' },
      ]);

      expect(pushDecision.mock.calls.map((c) => c[0]).sort()).toEqual([
        'U-a',
        'U-b',
      ]);
    });

    it('describes the named slots of a partial cancellation, else the live ones, else all', async () => {
      const day2 = {
        id: 's2',
        startAt: new Date('2026-09-19T02:00:00.000Z'),
        endAt: new Date('2026-09-19T05:00:00.000Z'),
        isCancelled: true,
      };
      const row = decisionRow({
        slots: [
          { id: 's1', startAt: START, endAt: END, isCancelled: false },
          day2,
        ],
      });
      bookingFindMany.mockResolvedValue([row]);

      await subject().notifyDecisions([
        { bookingId: 'bk1', status: 'CANCELLED_BY_USER', slotIds: ['s2'] },
        { bookingId: 'bk1', status: 'APPROVED' },
      ]);

      const byStatus = new Map(
        pushDecision.mock.calls.map((c) => [c[1].status, c[1]] as const),
      );
      expect(byStatus.get('CANCELLED_BY_USER')?.dateText).toBe('19 ก.ย. 2569');
      expect(byStatus.get('APPROVED')?.dateText).toBe('18 ก.ย. 2569');

      pushDecision.mockClear();
      bookingFindMany.mockResolvedValue([
        decisionRow({
          slots: [
            { id: 's1', startAt: START, endAt: END, isCancelled: true },
            day2,
          ],
        }),
      ]);
      await subject().notifyDecisions([
        { bookingId: 'bk1', status: 'CANCELLED_BY_STAFF' },
      ]);
      expect(pushDecision.mock.calls[0][1].dateText).toBe(
        '18 ก.ย. 2569 - 19 ก.ย. 2569 (2 ช่วงเวลา)',
      );
    });

    it('🔴 swallows a LINE failure, keeps sending the others, and logs ids only', async () => {
      bookingFindMany.mockResolvedValue([
        decisionRow(),
        decisionRow({
          id: 'bk2',
          lineUser: { lineUserId: 'U-two', deletedAt: null, settings: null },
        }),
      ]);
      pushDecision
        .mockRejectedValueOnce(new Error('403 blocked'))
        .mockResolvedValueOnce({});

      await expect(
        subject().notifyDecisions([
          { bookingId: 'bk1', status: 'REJECTED', reason: 'เหตุผลส่วนตัว' },
          { bookingId: 'bk2', status: 'APPROVED' },
        ]),
      ).resolves.toBeUndefined();

      expect(pushDecision).toHaveBeenCalledTimes(2);
      const log = warnings();
      expect(log).toContain('booking=bk1');
      expect(log).toContain('status=REJECTED');
      expect(log).toContain('403 blocked');
      // PII discipline: no purpose, no reason, no LINE id.
      expect(log).not.toContain('อบรม');
      expect(log).not.toContain('เหตุผลส่วนตัว');
      expect(log).not.toContain('U-owner');
    });

    it('swallows a failed read and pushes nothing', async () => {
      bookingFindMany.mockRejectedValue(new Error('connection terminated'));

      await expect(
        subject().notifyDecisions([{ bookingId: 'bk1', status: 'EXPIRED' }]),
      ).resolves.toBeUndefined();

      expect(pushDecision).not.toHaveBeenCalled();
      expect(warnings()).toContain('connection terminated');
    });
  });

  describe('notifyReminders', () => {
    const NOW = new Date(START.getTime() - 60 * MIN);

    const slotRow = (over: Record<string, unknown> = {}) => ({
      id: 's1',
      startAt: START,
      endAt: END,
      bookingRequest: {
        code: 'BR-25690918-001',
        purpose: 'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
        attendees: 50,
        venue: { name: 'ห้องประชุมใหญ่', location: 'ชั้น 3' },
        lineUser: { lineUserId: 'U-owner', deletedAt: null, settings: null },
      },
      ...over,
    });

    it('reads the claimed slots in ONE query and pushes a reminder per owner', async () => {
      slotFindMany.mockResolvedValue([slotRow()]);

      await subject().notifyReminders(['s1'], NOW);

      expect(slotFindMany).toHaveBeenCalledTimes(1);
      expect(
        (slotFindMany.mock.calls[0][0] as { where: unknown }).where,
      ).toEqual({ id: { in: ['s1'] } });
      expect(pushReminder).toHaveBeenCalledWith('U-owner', {
        leadTimeText: '1 ชั่วโมง',
        bookingCode: 'BR-25690918-001',
        purpose: 'อบรมเชิงปฏิบัติการพัฒนาเว็บแอป',
        attendees: 50,
        venueName: 'ห้องประชุมใหญ่',
        venueLocation: 'ชั้น 3',
        dateText: 'วันนี้ (18 ก.ย. 2569)',
        periodText: '09:00 - 12:00 น.',
      });
    });

    it('skips a user who switched reminders off', async () => {
      slotFindMany.mockResolvedValue([
        slotRow({
          bookingRequest: {
            ...slotRow().bookingRequest,
            lineUser: {
              lineUserId: 'U-owner',
              deletedAt: null,
              settings: { notifications: { reminders: false } },
            },
          },
        }),
      ]);

      await subject().notifyReminders(['s1'], NOW);

      expect(pushReminder).not.toHaveBeenCalled();
    });

    it('does nothing for an empty batch', async () => {
      await subject().notifyReminders([], NOW);

      expect(slotFindMany).not.toHaveBeenCalled();
    });

    it('swallows a LINE failure and a failed read, logging slot ids only', async () => {
      slotFindMany.mockResolvedValueOnce([slotRow()]);
      pushReminder.mockRejectedValueOnce(new Error('429 quota'));

      await expect(
        subject().notifyReminders(['s1'], NOW),
      ).resolves.toBeUndefined();
      slotFindMany.mockRejectedValueOnce(new Error('db down'));
      await expect(
        subject().notifyReminders(['s1'], NOW),
      ).resolves.toBeUndefined();

      const log = warnings();
      expect(log).toContain('slot=s1');
      expect(log).toContain('429 quota');
      expect(log).toContain('db down');
      expect(log).not.toContain('U-owner');
      expect(log).not.toContain('อบรม');
    });
  });
});
