import { FeedbackType, Prisma } from '@prisma/client';
import { bookingCodeDatePart } from '../bookings/booking-code';
import { formatFeedbackCode, nextFeedbackCode } from './feedback-code';

/**
 * The reference code is the one string in this domain a human reads aloud, and every bug it can
 * have is either a time-zone bug or a scoping bug. These run on pure functions with fixed instants,
 * so they say the same thing on a laptop in Bangkok and in a CI container in UTC — which is the
 * property being tested. The date machinery itself is `booking-code.spec.ts`' subject; what is
 * tested here is that this module USES it and that the sequence is scoped per type.
 */
describe('feedback-code', () => {
  describe('formatFeedbackCode', () => {
    it('numbers from 001, with the prefix chosen by type', () => {
      const at = new Date('2026-09-20T04:00:00.000Z'); // 11:00 Bangkok on 20 Sep 2026.
      expect(formatFeedbackCode(FeedbackType.ISSUE, at, 0)).toBe(
        'ISS-25690920-001',
      );
      expect(formatFeedbackCode(FeedbackType.FEEDBACK, at, 0)).toBe(
        'FDB-25690920-001',
      );
      expect(formatFeedbackCode(FeedbackType.ISSUE, at, 41)).toBe(
        'ISS-25690920-042',
      );
    });

    it('🔴 stamps BANGKOK’s day, not the server’s', () => {
      // 17:00Z on the 20th is already 00:00 on the 21st in Bangkok. A container running in UTC
      // would otherwise print yesterday's date on a report submitted today.
      expect(
        formatFeedbackCode(
          FeedbackType.ISSUE,
          new Date('2026-09-20T17:00:00.000Z'),
          0,
        ),
      ).toBe('ISS-25690921-001');
      // And one millisecond earlier is still the 20th — the boundary is exact.
      expect(
        formatFeedbackCode(
          FeedbackType.ISSUE,
          new Date('2026-09-20T16:59:59.999Z'),
          0,
        ),
      ).toBe('ISS-25690920-001');
    });

    it('widens rather than wraps past 999', () => {
      // An ugly code beats a collision: the 1000th submission of one day must still be unique.
      expect(
        formatFeedbackCode(
          FeedbackType.FEEDBACK,
          new Date('2026-09-20T04:00:00.000Z'),
          999,
        ),
      ).toBe('FDB-25690920-1000');
    });

    it('shares ONE date rule with the booking code', () => {
      // Not a tautology: it is the assertion that this module imports `bookingCodeDatePart` rather
      // than carrying a second copy of the UTC+7 shift and the Buddhist-era offset. A forked copy
      // that drifted would fail here first.
      for (const iso of [
        '2026-01-05T03:00:00.000Z',
        '2026-09-20T16:59:59.999Z',
        '2026-12-31T18:00:00.000Z',
      ]) {
        const at = new Date(iso);
        expect(formatFeedbackCode(FeedbackType.ISSUE, at, 0)).toBe(
          `ISS-${bookingCodeDatePart(at)}-001`,
        );
      }
    });
  });

  describe('nextFeedbackCode', () => {
    /** The transaction client, reduced to the one delegate this function touches. */
    const txWith = (count: number) => {
      const feedback = {
        count: jest.fn<
          Promise<number>,
          [
            {
              where: { type: FeedbackType; createdAt: { gte: Date; lt: Date } };
            },
          ]
        >(() => Promise.resolve(count)),
      };
      return {
        tx: { feedback } as unknown as Prisma.TransactionClient,
        feedback,
      };
    };

    it('counts the caller’s type over the Bangkok day, and numbers the next one', async () => {
      const { tx, feedback } = txWith(2);
      const now = new Date('2026-09-20T04:00:00.000Z');

      await expect(nextFeedbackCode(tx, FeedbackType.ISSUE, now)).resolves.toBe(
        'ISS-25690920-003',
      );

      // 🔴 THE FROZEN `where` SHAPE. Bangkok midnight on the 20th is 17:00Z on the 19th; the window
      // is half-open and exactly 24 hours wide, and it MUST agree with the printed date or the
      // sequence restarts at 07:00 and mints a duplicate seven hours into every day.
      const where = feedback.count.mock.calls[0][0].where;
      expect(where.type).toBe(FeedbackType.ISSUE);
      expect(where.createdAt.gte.toISOString()).toBe(
        '2026-09-19T17:00:00.000Z',
      );
      expect(where.createdAt.lt.toISOString()).toBe('2026-09-20T17:00:00.000Z');
    });

    it('🔴 scopes the counter PER TYPE — the two prefixes are two sequences', async () => {
      // A shared counter would print ISS-…-001 then ISS-…-003, and the number a reporter reads as
      // "the 3rd issue today" would be a lie told by a suggestion they cannot see.
      const { tx, feedback } = txWith(0);
      const now = new Date('2026-09-20T04:00:00.000Z');

      await expect(
        nextFeedbackCode(tx, FeedbackType.FEEDBACK, now),
      ).resolves.toBe('FDB-25690920-001');
      expect(feedback.count.mock.calls[0][0].where.type).toBe(
        FeedbackType.FEEDBACK,
      );
    });
  });
});
