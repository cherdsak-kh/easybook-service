import { Logger } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { publishBookingRequests } from './booking-realtime';

const ACTOR = { id: 'op-1', name: 'วีระ ทองดี' };

/** One row in the queue-row shape — what `BOOKING_LIST_SELECT` returns. */
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
  venue: { id: 'venue-1', name: 'หอประชุมวารณ', location: null },
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

  beforeEach(() => jest.clearAllMocks());

  it('reads the whole batch in ONE query and emits once per row', async () => {
    findMany.mockResolvedValue([row('a'), row('b'), row('c')]);

    await publishBookingRequests(
      prisma,
      realtime,
      'updated',
      ['a', 'b', 'c'],
      ACTOR,
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(3);
    expect(created).not.toHaveBeenCalled();
  });

  /** The subject must reach the wire before the losers it displaced, whatever order Postgres used. */
  it('emits in the CALLER’s order, not the database’s', async () => {
    findMany.mockResolvedValue([row('c'), row('a'), row('b')]);

    await publishBookingRequests(
      prisma,
      realtime,
      'updated',
      ['a', 'b', 'c'],
      ACTOR,
    );

    expect(
      [0, 1, 2].map((n) => (updated.mock.calls as [{ id: string }][])[n][0].id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('does NOTHING at all for an empty id list — not even a query', async () => {
    await publishBookingRequests(prisma, realtime, 'updated', [], ACTOR);

    expect(findMany).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
  });

  /** A row deleted between the commit and the read has no honest payload; it is dropped. */
  it('skips an id that no longer resolves rather than inventing a payload', async () => {
    findMany.mockResolvedValue([row('a')]);

    await publishBookingRequests(
      prisma,
      realtime,
      'created',
      ['a', 'gone'],
      null,
    );

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

    await publishBookingRequests(prisma, realtime, 'updated', ['a'], {
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

      await expect(
        publishBookingRequests(prisma, realtime, 'updated', ['a'], ACTOR),
      ).resolves.toBeUndefined();
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

      await expect(
        publishBookingRequests(prisma, realtime, 'updated', ['a'], ACTOR),
      ).resolves.toBeUndefined();
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

      await publishBookingRequests(prisma, realtime, 'updated', ['a'], ACTOR);

      const text = String(warn.mock.calls[0][0]);
      expect(text).not.toContain('สพท.');
      expect(text).not.toContain('02-000-0000');
      expect(text).not.toContain('ประชุมเตรียมงานกีฬาสี');
      expect(text).toContain('ids=a');

      warn.mockRestore();
    });
  });
});
