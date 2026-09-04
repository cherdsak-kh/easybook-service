import { BadRequestException, ConflictException } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import {
  approvedClashWhere,
  assertNoApprovedClash,
  findApprovedClash,
  findPendingLosers,
  isOverlapViolation,
  isTransactionRace,
  overlapOr,
  OVERLAP_CONSTRAINT,
  parseSlots,
  type SlotSpan,
} from './booking-overlap';
import {
  SLOT_IN_THE_PAST,
  SLOT_RANGE_INVALID,
  SLOT_SELF_OVERLAP,
  SLOT_TAKEN,
} from './bookings.constants';

const VENUE = 'clx_venue_cuid';
const REQUEST = 'clx_request_cuid';
const HOUR = 3_600_000;
const DAY = 86_400_000;

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();

const span = (startMs: number, endMs: number): SlotSpan => ({
  start: new Date(startMs),
  end: new Date(endMs),
});

/** The two-node error shape `@prisma/adapter-pg` was MEASURED producing for a 23P01. */
const driverAdapterError = (code: string, message: string) => {
  const err = new Error(message) as Error & { cause?: unknown };
  err.cause = { code, originalCode: code, message };
  return err;
};

/**
 * The first argument of a mock's Nth call, typed.
 *
 * ⚠️ `jest.fn()` without generics infers its call tuple as `any`, and this repo's type-checked
 * ESLint config rejects every member access on one. Routing the read through here keeps the casts
 * in ONE place instead of scattering `as`-chains across every assertion.
 */
const callArg = <T>(fn: jest.Mock, call = 0): T =>
  (fn.mock.calls as unknown as unknown[][])[call][0] as T;

describe('booking-overlap', () => {
  // ────────────────────────────────────────────────────────────────────────────────
  // The half-open comparison — AC-BR18. This is the single copy in the codebase, so
  // these are the only tests standing between `<` and `<=`.
  // ────────────────────────────────────────────────────────────────────────────────
  describe('overlapOr', () => {
    it('emits one strict-inequality clause per span', () => {
      const s = span(1_000, 2_000);
      expect(overlapOr([s])).toEqual([
        { startAt: { lt: s.end }, endAt: { gt: s.start } },
      ]);
    });

    it('emits one clause per span and preserves order', () => {
      const a = span(0, HOUR);
      const b = span(DAY, DAY + HOUR);
      const clauses = overlapOr([a, b]);
      expect(clauses).toHaveLength(2);
      expect(clauses[0].startAt).toEqual({ lt: a.end });
      expect(clauses[1].endAt).toEqual({ gt: b.start });
    });

    /**
     * 🔴 THE BOUNDARY, BOTH SIDES. The `where` is evaluated here in TypeScript exactly as Postgres
     * would evaluate it: `theirs.startAt < mine.end && theirs.endAt > mine.start`. Writing either
     * comparison as non-strict makes back-to-back slots collide, which is the phantom conflict
     * nobody can reproduce.
     */
    it.each([
      ['ends exactly when mine starts', 0, HOUR, HOUR, 2 * HOUR, false],
      [
        'starts exactly when mine ends',
        2 * HOUR,
        3 * HOUR,
        HOUR,
        2 * HOUR,
        false,
      ],
      [
        'overlaps by one millisecond at the end',
        0,
        HOUR + 1,
        HOUR,
        2 * HOUR,
        true,
      ],
      [
        'overlaps by one millisecond at the start',
        2 * HOUR - 1,
        3 * HOUR,
        HOUR,
        2 * HOUR,
        true,
      ],
      [
        'is entirely inside mine',
        90 * 60_000,
        100 * 60_000,
        HOUR,
        3 * HOUR,
        true,
      ],
      ['entirely contains mine', 0, 4 * HOUR, HOUR, 2 * HOUR, true],
      ['is a whole day away', 5 * DAY, 5 * DAY + HOUR, HOUR, 2 * HOUR, false],
    ])(
      'a slot that %s → overlaps: %j',
      (_label, theirStart, theirEnd, myStart, myEnd, expected) => {
        const [clause] = overlapOr([span(myStart, myEnd)]);
        const matches =
          theirStart < (clause.startAt as { lt: Date }).lt.getTime() &&
          theirEnd > (clause.endAt as { gt: Date }).gt.getTime();
        expect(matches).toBe(expected);
      },
    );
  });

  describe('approvedClashWhere', () => {
    /**
     * 🔴 THE SHAPE IS LOAD-BEARING. `bookings.service.spec.ts` asserts these exact keys on the LIFF
     * path and must stay green unedited; and swapping this predicate for a read of `holdsSlot` would
     * turn an index key the database owns into a second source of truth the app trusts.
     */
    it('filters on the PARENT’s status and never on `holdsSlot`', () => {
      const where = approvedClashWhere(VENUE, [span(0, HOUR)]);
      expect(where.venueId).toBe(VENUE);
      expect(where.isCancelled).toBe(false);
      expect(where.bookingRequest).toEqual({
        status: BookingStatus.APPROVED,
      });
      expect(where.OR).toHaveLength(1);
      expect(JSON.stringify(where)).not.toContain('holdsSlot');
    });

    it('adds `bookingRequestId: { not }` only when excluding, leaving the other keys untouched', () => {
      const plain = approvedClashWhere(VENUE, [span(0, HOUR)]);
      expect(plain.bookingRequestId).toBeUndefined();

      const excluding = approvedClashWhere(VENUE, [span(0, HOUR)], REQUEST);
      expect(excluding.bookingRequestId).toEqual({ not: REQUEST });
      // The exclusion must NOT be folded into `bookingRequest`, which the LIFF spec pins.
      expect(excluding.bookingRequest).toEqual({
        status: BookingStatus.APPROVED,
      });
    });
  });

  describe('findApprovedClash / assertNoApprovedClash', () => {
    const tx = () => ({
      bookingSlot: { findFirst: jest.fn() },
      bookingRequest: { findMany: jest.fn() },
    });

    it('returns null and issues NO query when there are no spans', async () => {
      const t = tx();
      await expect(
        findApprovedClash(t as unknown as Prisma.TransactionClient, VENUE, []),
      ).resolves.toBeNull();
      expect(t.bookingSlot.findFirst).not.toHaveBeenCalled();
    });

    it('throws 409 SLOT_TAKEN when a clash is found, naming nobody', async () => {
      const t = tx();
      t.bookingSlot.findFirst.mockResolvedValue({
        id: 'slot',
        bookingRequestId: 'other',
      });
      await expect(
        assertNoApprovedClash(t as unknown as Prisma.TransactionClient, VENUE, [
          span(0, HOUR),
        ]),
      ).rejects.toThrow(new ConflictException(SLOT_TAKEN));
      // `D-C13`'s privacy clause: the refusal reveals neither the holder nor their purpose.
      expect(SLOT_TAKEN).not.toMatch(/who|name|purpose/i);
    });

    it('resolves quietly when nothing clashes', async () => {
      const t = tx();
      t.bookingSlot.findFirst.mockResolvedValue(null);
      await expect(
        assertNoApprovedClash(t as unknown as Prisma.TransactionClient, VENUE, [
          span(0, HOUR),
        ]),
      ).resolves.toBeUndefined();
    });
  });

  describe('findPendingLosers', () => {
    const tx = () => ({ bookingRequest: { findMany: jest.fn() } });

    it('asks for PENDING requests at this venue with a LIVE overlapping slot, ordered by code', async () => {
      const t = tx();
      t.bookingRequest.findMany.mockResolvedValue([]);
      await findPendingLosers(
        t as unknown as Prisma.TransactionClient,
        VENUE,
        [span(0, HOUR)],
        { excludeRequestId: REQUEST },
      );

      const args = callArg<{
        where: {
          venueId: string;
          status: BookingStatus;
          id?: { not: string };
          slots: { some: { isCancelled: boolean; OR: unknown[] } };
        };
        orderBy: unknown;
      }>(t.bookingRequest.findMany);
      expect(args.where.venueId).toBe(VENUE);
      expect(args.where.status).toBe(BookingStatus.PENDING);
      expect(args.where.id).toEqual({ not: REQUEST });
      // A cancelled slot holds nothing, so a request whose overlap is cancelled is not a loser.
      expect(args.where.slots.some.isCancelled).toBe(false);
      expect(args.where.slots.some.OR).toHaveLength(1);
      // Deterministic: two runs over the same data must report the same list.
      expect(args.orderBy).toEqual({ code: 'asc' });
    });

    it('returns an empty list and issues NO query when there are no spans', async () => {
      const t = tx();
      await expect(
        findPendingLosers(
          t as unknown as Prisma.TransactionClient,
          VENUE,
          [],
          {},
        ),
      ).resolves.toEqual([]);
      expect(t.bookingRequest.findMany).not.toHaveBeenCalled();
    });

    it('omits the id exclusion when there is no request yet (the direct-booking path)', async () => {
      const t = tx();
      t.bookingRequest.findMany.mockResolvedValue([]);
      await findPendingLosers(t as unknown as Prisma.TransactionClient, VENUE, [
        span(0, HOUR),
      ]);
      const args = callArg<{
        where: { id?: unknown };
      }>(t.bookingRequest.findMany);
      expect(args.where.id).toBeUndefined();
    });
  });

  describe('parseSlots', () => {
    it('converts strings to Dates and keeps the caller’s order', () => {
      const out = parseSlots([
        { startAt: iso(2 * DAY), endAt: iso(2 * DAY + HOUR) },
        { startAt: iso(DAY), endAt: iso(DAY + HOUR) },
      ]);
      expect(out).toHaveLength(2);
      expect(out[0].start.getTime()).toBeGreaterThan(out[1].start.getTime());
    });

    it('400s a span that ends before or exactly when it starts', () => {
      expect(() =>
        parseSlots([{ startAt: iso(DAY + HOUR), endAt: iso(DAY) }]),
      ).toThrow(new BadRequestException(SLOT_RANGE_INVALID));
      const same = iso(DAY);
      expect(() => parseSlots([{ startAt: same, endAt: same }])).toThrow(
        new BadRequestException(SLOT_RANGE_INVALID),
      );
    });

    it('400s a span starting in the past — compared against NOW, not midnight', () => {
      expect(() =>
        parseSlots([{ startAt: iso(-HOUR), endAt: iso(HOUR) }]),
      ).toThrow(new BadRequestException(SLOT_IN_THE_PAST));
    });

    it('400s two spans of the SAME request that overlap each other', () => {
      expect(() =>
        parseSlots([
          { startAt: iso(DAY), endAt: iso(DAY + 3 * HOUR) },
          { startAt: iso(DAY + 2 * HOUR), endAt: iso(DAY + 4 * HOUR) },
        ]),
      ).toThrow(new BadRequestException(SLOT_SELF_OVERLAP));
    });

    it('accepts back-to-back spans of the same request — half-open, so they do not overlap', () => {
      const boundary = iso(DAY + 3 * HOUR);
      expect(
        parseSlots([
          { startAt: iso(DAY), endAt: boundary },
          { startAt: boundary, endAt: iso(DAY + 5 * HOUR) },
        ]),
      ).toHaveLength(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // AC-BR22 — the 23P01 that has no Prisma error code must not become a 500.
  // ────────────────────────────────────────────────────────────────────────────────
  describe('isOverlapViolation', () => {
    it('recognises the MEASURED DriverAdapterError shape (code on `cause`)', () => {
      expect(
        isOverlapViolation(
          driverAdapterError(
            '23P01',
            `conflicting key value violates exclusion constraint "${OVERLAP_CONSTRAINT}"`,
          ),
        ),
      ).toBe(true);
    });

    it('recognises the SQLSTATE on the top-level error too', () => {
      expect(isOverlapViolation({ code: '23P01' })).toBe(true);
      expect(isOverlapViolation({ originalCode: '23P01' })).toBe(true);
    });

    it('recognises it by CONSTRAINT NAME when the code is wrapped away', () => {
      // The second net: a driver upgrade may re-shape the chain, but the constraint's name in the
      // message is shape-independent.
      expect(
        isOverlapViolation(
          new Error(
            `conflicting key value violates exclusion constraint "${OVERLAP_CONSTRAINT}"`,
          ),
        ),
      ).toBe(true);
    });

    it('walks `meta.cause`, which is where a Prisma-wrapped raw error puts it', () => {
      expect(isOverlapViolation({ meta: { cause: { code: '23P01' } } })).toBe(
        true,
      );
    });

    /** ⚠️ Anything else must be RETHROWN. A swallowed bug that answers 409 is never investigated. */
    it('returns false for a unique violation, a deadlock, and plain junk', () => {
      expect(isOverlapViolation({ code: '23505' })).toBe(false);
      expect(isOverlapViolation({ code: '40P01' })).toBe(false);
      expect(isOverlapViolation(new Error('boom'))).toBe(false);
      expect(isOverlapViolation(null)).toBe(false);
      expect(isOverlapViolation(undefined)).toBe(false);
      expect(isOverlapViolation('23P01')).toBe(false);
    });

    it('terminates on a cyclic cause chain', () => {
      const a: { cause?: unknown; code?: string } = {};
      const b: { cause?: unknown } = { cause: a };
      a.cause = b;
      expect(isOverlapViolation(a)).toBe(false);
    });
  });

  describe('isTransactionRace', () => {
    it('recognises 40P01 and 40001 anywhere in the chain', () => {
      expect(isTransactionRace(driverAdapterError('40P01', 'deadlock'))).toBe(
        true,
      );
      expect(
        isTransactionRace(driverAdapterError('40001', 'serialization')),
      ).toBe(true);
    });

    it('recognises Prisma’s own P2034', () => {
      expect(
        isTransactionRace(
          new Prisma.PrismaClientKnownRequestError('conflict', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        ),
      ).toBe(true);
    });

    /** The two guards must not overlap: an exclusion violation is not retryable. */
    it('does NOT claim an exclusion violation', () => {
      expect(isTransactionRace(driverAdapterError('23P01', 'overlap'))).toBe(
        false,
      );
    });
  });
});
