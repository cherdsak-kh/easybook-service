import { Logger } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClientRealtimeGateway } from '../realtime/client-realtime.gateway';
import { CLIENT_REALTIME_EVENTS } from '../realtime/realtime.constants';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { publishBookingRequests } from './booking-realtime';

const ACTOR = { id: 'op-1', name: 'วีระ ทองดี' };

const VENUE_ID = 'venue-1';
const LINE_USER_CUID = 'clx0lineuser000000000000';

/**
 * One row as BOTH reads see it.
 *
 * The `/admin` read (`BOOKING_LIST_SELECT`) and the `/client` read (`CLIENT_FANOUT_SELECT`) land on
 * the same `findMany` mock, so this fixture is the union of the two selects. The extra scalars are
 * invisible to `toBookingListDto`, which maps by field and ignores anything it was not asked for.
 *
 * ⚠️ `lineUserId` IS A cuid (`LineUser.id`), never a `U…` sub — that is the value `user:<…>` rooms
 * are keyed on, and getting it wrong is a silent no-delivery rather than an error.
 */
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  code: `BR-25690903-${id}`,
  status: BookingStatus.PENDING,
  createdById: null,
  purpose: 'ประชุมเตรียมงานกีฬาสี',
  attendees: 25,
  firstStartAt: new Date('2026-09-10T02:00:00.000Z'),
  lastEndAt: new Date('2026-09-10T04:00:00.000Z'),
  rejectReason: null,
  createdAt: new Date('2026-09-04T09:00:00.000Z'),
  requesterName: 'สพท.',
  contactPhone: '02-000-0000',
  department: null,
  lineUser: null,
  lineUserId: LINE_USER_CUID,
  venueId: VENUE_ID,
  venue: { id: VENUE_ID, name: 'หอประชุมวารณ', location: null },
  slots: [],
  ...over,
});

describe('publishBookingRequests', () => {
  const findMany = jest.fn();
  const prisma = {
    bookingRequest: { findMany },
  } as unknown as PrismaService;

  // Declared as free consts and then composed, rather than read back off the object: reading a
  // method off an instance trips `@typescript-eslint/unbound-method`, and it is right to.
  const created = jest.fn();
  const updated = jest.fn();
  const realtime = {
    emitBookingRequestCreated: created,
    emitBookingRequestUpdated: updated,
  } as unknown as RealtimeGateway;

  const toUser = jest.fn();
  const toVenue = jest.fn();
  const schedulePulse = jest.fn();
  const client = {
    emitToUser: toUser,
    emitToVenue: toVenue,
    emitSchedulePulse: schedulePulse,
  } as unknown as ClientRealtimeGateway;

  const publish = (
    kind: 'created' | 'updated',
    ids: readonly string[],
    actor: typeof ACTOR | null = ACTOR,
  ) => publishBookingRequests(prisma, realtime, client, kind, ids, actor);

  beforeEach(() => jest.clearAllMocks());

  it('reads the whole batch in TWO queries — one per namespace — and emits once per row', async () => {
    findMany.mockResolvedValue([row('a'), row('b'), row('c')]);

    await publish('updated', ['a', 'b', 'c']);

    // Two: the `/admin` queue-row re-read and the narrow `/client` re-read. The number that matters
    // is that it does NOT grow with the batch — three ids, still two queries, never one per id.
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(updated).toHaveBeenCalledTimes(3);
    expect(created).not.toHaveBeenCalled();
  });

  /** The subject must reach the wire before the losers it displaced, whatever order Postgres used. */
  it('emits in the CALLER’s order, not the database’s', async () => {
    findMany.mockResolvedValue([row('c'), row('a'), row('b')]);

    await publish('updated', ['a', 'b', 'c']);

    expect(
      [0, 1, 2].map((n) => (updated.mock.calls as [{ id: string }][])[n][0].id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('does NOTHING at all for an empty id list — not even a query', async () => {
    await publish('updated', []);

    expect(findMany).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
    expect(toUser).not.toHaveBeenCalled();
    expect(toVenue).not.toHaveBeenCalled();
    expect(schedulePulse).not.toHaveBeenCalled();
  });

  /** A row deleted between the commit and the read has no honest payload; it is dropped. */
  it('skips an id that no longer resolves rather than inventing a payload', async () => {
    findMany.mockResolvedValue([row('a')]);

    await publish('created', ['a', 'gone'], null);

    expect(created).toHaveBeenCalledTimes(1);
    expect((created.mock.calls as [{ id: string }, unknown][])[0][0].id).toBe(
      'a',
    );
    // `null` travels through untouched — a LINE user submitted it, nobody operated.
    expect((created.mock.calls as [unknown, unknown][])[0][1]).toBeNull();
  });

  /** Narrowed explicitly: a structural type does not strip an extra property at RUNTIME. */
  it('puts id + name on the wire and never the operator’s role', async () => {
    findMany.mockResolvedValue([row('a')]);

    await publish('updated', ['a'], {
      ...ACTOR,
      role: 'ADMIN',
    } as typeof ACTOR);

    const [, actor] = (updated.mock.calls as [unknown, unknown][])[0];
    expect(actor).toEqual(ACTOR);
    expect(actor).not.toHaveProperty('role');
  });

  describe('fail-soft (the write has already committed)', () => {
    it('swallows a failing read and never rejects', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      findMany.mockRejectedValue(new Error('connection terminated'));

      await expect(publish('updated', ['a'])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it('swallows a throwing transport and never rejects', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      findMany.mockResolvedValue([row('a')]);
      updated.mockImplementationOnce(() => {
        throw new Error('transport down');
      });

      await expect(publish('updated', ['a'])).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    /** PDPA: the requester's name, their phone and the purpose pass through here. None may be logged. */
    it('logs ids only — never a name, a phone or a purpose', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      findMany.mockResolvedValue([row('a')]);
      updated.mockImplementationOnce(() => {
        throw new Error('transport down');
      });

      await publish('updated', ['a']);

      const text = String(warn.mock.calls[0][0]);
      expect(text).not.toContain('สพท.');
      expect(text).not.toContain('02-000-0000');
      expect(text).not.toContain('ประชุมเตรียมงานกีฬาสี');
      expect(text).toContain('ids=a');

      warn.mockRestore();
    });

    /**
     * The two namespaces are independent audiences. `/admin` failing must not cost the requester the
     * toast that tells them their booking was refused — which is why each half has its own catch.
     */
    it('a throwing /admin transport still delivers the /client events', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      findMany.mockResolvedValue([
        row('a', { status: BookingStatus.APPROVED }),
      ]);
      updated.mockImplementationOnce(() => {
        throw new Error('transport down');
      });

      await expect(publish('updated', ['a'])).resolves.toBeUndefined();

      expect(toUser).toHaveBeenCalledTimes(1);
      expect(toVenue).toHaveBeenCalledTimes(1);
      expect(schedulePulse).toHaveBeenCalledTimes(1);

      warn.mockRestore();
    });

    it('a throwing /client transport still delivers the /admin events, and logs ids only', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      findMany.mockResolvedValue([
        row('a', {
          status: BookingStatus.REJECTED,
          rejectReason: 'ห้องถูกจองโดยคำขออื่น',
        }),
      ]);
      toUser.mockImplementationOnce(() => {
        throw new Error('transport down');
      });

      await expect(publish('updated', ['a'])).resolves.toBeUndefined();

      expect(updated).toHaveBeenCalledTimes(1);
      const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('ids=a');
      expect(text).not.toContain('ห้องถูกจองโดยคำขออื่น');

      warn.mockRestore();
    });
  });

  // ─────────────────────── the /client half (CLIENT-REALTIME-1) ───────────────────────

  describe('the /client fan-out', () => {
    /** `D-C13`: the reject reason is one person's business, so it goes to one person's room. */
    it('APPROVED sends bookingUpdated to the owner, availability to the venue, and a schedule pulse', async () => {
      findMany.mockResolvedValue([
        row('a', { status: BookingStatus.APPROVED }),
      ]);

      await publish('updated', ['a']);

      expect(toUser).toHaveBeenCalledWith(
        LINE_USER_CUID,
        CLIENT_REALTIME_EVENTS.bookingUpdated,
        {
          id: 'a',
          code: 'BR-25690903-a',
          status: BookingStatus.APPROVED,
          rejectReason: null,
        },
      );
      expect(toVenue).toHaveBeenCalledWith(
        VENUE_ID,
        CLIENT_REALTIME_EVENTS.venueAvailabilityChanged,
        { venueId: VENUE_ID },
      );
      expect(schedulePulse).toHaveBeenCalledTimes(1);
    });

    it('CANCELLED pulses the schedule too — the block leaves the org-wide day view', async () => {
      findMany.mockResolvedValue([
        row('a', { status: BookingStatus.CANCELLED }),
      ]);

      await publish('updated', ['a']);

      expect(schedulePulse).toHaveBeenCalledTimes(1);
    });

    /** A rejected request never occupied the schedule, so there is nothing for `schedule:all` to say. */
    it('REJECTED reaches the owner and the venue but NEVER the shared schedule room', async () => {
      findMany.mockResolvedValue([
        row('a', {
          status: BookingStatus.REJECTED,
          rejectReason: 'ห้องถูกจองโดยคำขออื่น',
        }),
      ]);

      await publish('updated', ['a']);

      expect(toUser).toHaveBeenCalledWith(
        LINE_USER_CUID,
        CLIENT_REALTIME_EVENTS.bookingUpdated,
        expect.objectContaining({ rejectReason: 'ห้องถูกจองโดยคำขออื่น' }),
      );
      expect(toVenue).toHaveBeenCalledTimes(1);
      expect(schedulePulse).not.toHaveBeenCalled();
    });

    /**
     * 🔴 THE `D-C13` ASSERTION IN UNIT FORM. The venue room is shared by everyone with that calendar
     * open, so its payload may name the venue and NOTHING about the request — no code, no reject
     * reason, no requester, no purpose.
     */
    it('the venue payload carries the venue id and nothing else', async () => {
      findMany.mockResolvedValue([
        row('a', {
          status: BookingStatus.REJECTED,
          rejectReason: 'ห้องถูกจองโดยคำขออื่น',
        }),
      ]);

      await publish('updated', ['a']);

      const [, , payload] = (
        toVenue.mock.calls as [string, string, unknown][]
      )[0];
      expect(payload).toEqual({ venueId: VENUE_ID });
      expect(JSON.stringify(payload)).not.toContain('BR-25690903');
      expect(JSON.stringify(payload)).not.toContain('ห้องถูกจองโดยคำขออื่น');
    });

    /** `emitSchedulePulse` takes no argument at all — the compiler and this assertion both say so. */
    it('the schedule pulse is called with no payload whatsoever', async () => {
      findMany.mockResolvedValue([
        row('a', { status: BookingStatus.APPROVED }),
      ]);

      await publish('updated', ['a']);

      expect(schedulePulse.mock.calls[0]).toEqual([]);
    });

    /**
     * 🔴 THE OCCUPANCY RULE AND THE FAN-OUT RULE HAVE TO AGREE. `OCCUPYING_STATUSES` is
     * `[APPROVED, PENDING]`, so a brand-new LIFF submission takes that hour off `#/venue/:id` for
     * everybody else the moment it commits. Announcing only `APPROVED` left a competing user free to
     * pick the same slot until they happened to refetch.
     */
    it('a PENDING row reaches the owner and the venue — the slot is occupied from the moment it lands', async () => {
      findMany.mockResolvedValue([row('a')]);

      await publish('created', ['a'], null);

      expect(created).toHaveBeenCalledTimes(1);
      expect(toUser).toHaveBeenCalledWith(
        LINE_USER_CUID,
        CLIENT_REALTIME_EVENTS.bookingUpdated,
        {
          id: 'a',
          code: 'BR-25690903-a',
          status: BookingStatus.PENDING,
          rejectReason: null,
        },
      );
      expect(toVenue).toHaveBeenCalledWith(
        VENUE_ID,
        CLIENT_REALTIME_EVENTS.venueAvailabilityChanged,
        { venueId: VENUE_ID },
      );
    });

    /**
     * 🔴 THE PRIVACY-RELEVANT HALF, AND IT IS ASSERTED AS AN ABSENCE ON PURPOSE. `schedule:all` holds
     * every connected end-user and `#/home` is approved-only: a pulse on a pending submission would
     * both announce that an unapproved request exists and make every open client refetch a view that
     * cannot have changed.
     */
    it('a PENDING row NEVER pulses the shared schedule room, on either kind', async () => {
      findMany.mockResolvedValue([row('a')]);

      await publish('created', ['a'], null);
      await publish('updated', ['a'], null);

      expect(toVenue).toHaveBeenCalledTimes(2);
      expect(schedulePulse).not.toHaveBeenCalled();
    });

    /** `D-C18` again, for the status that now announces: a staff row has no `user:` room to reach. */
    it('a PENDING row with no lineUserId moves the venue only, and still no pulse', async () => {
      findMany.mockResolvedValue([row('a', { lineUserId: null })]);

      await publish('updated', ['a']);

      expect(toUser).not.toHaveBeenCalled();
      expect(toVenue).toHaveBeenCalledTimes(1);
      expect(schedulePulse).not.toHaveBeenCalled();
    });

    /**
     * A staff direct booking is born `APPROVED` with `kind: 'created'`. Status decides, not kind —
     * gating the client half on `kind === 'updated'` would silently drop the busiest calendar write
     * in the product.
     */
    it('a `created` row that is already APPROVED still announces on /client', async () => {
      findMany.mockResolvedValue([
        row('a', { status: BookingStatus.APPROVED, lineUserId: null }),
      ]);

      await publish('created', ['a']);

      expect(toVenue).toHaveBeenCalledTimes(1);
      expect(schedulePulse).toHaveBeenCalledTimes(1);
    });

    /** `D-C18`: a staff booking for somebody with no LINE account has no `user:` room to reach. */
    it('a row with no lineUserId skips the user room but still moves the venue and schedule', async () => {
      findMany.mockResolvedValue([
        row('a', { status: BookingStatus.APPROVED, lineUserId: null }),
      ]);

      await publish('updated', ['a']);

      expect(toUser).not.toHaveBeenCalled();
      expect(toVenue).toHaveBeenCalledTimes(1);
      expect(schedulePulse).toHaveBeenCalledTimes(1);
    });

    /** ADR-001 auto-rejects the losers of an approval: one client event per row that changed. */
    it('announces every row in the batch, not just the subject', async () => {
      findMany.mockResolvedValue([
        row('subject', { status: BookingStatus.APPROVED }),
        row('loser-1', {
          status: BookingStatus.REJECTED,
          lineUserId: 'clx0other0000000000000001',
        }),
        row('loser-2', {
          status: BookingStatus.REJECTED,
          lineUserId: 'clx0other0000000000000002',
        }),
      ]);

      await publish('updated', ['subject', 'loser-1', 'loser-2']);

      expect(toUser).toHaveBeenCalledTimes(3);
      expect(
        (toUser.mock.calls as [string, string, unknown][]).map(
          ([room]) => room,
        ),
      ).toEqual([
        LINE_USER_CUID,
        'clx0other0000000000000001',
        'clx0other0000000000000002',
      ]);
      // Only the approval touched the org-wide schedule; the two rejections never occupied it.
      expect(schedulePulse).toHaveBeenCalledTimes(1);
    });
  });
});
