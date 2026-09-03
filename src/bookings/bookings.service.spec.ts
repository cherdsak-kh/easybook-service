import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppAccess, BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingsService } from './bookings.service';
import {
  BOOKING_NOT_ALLOWED,
  SLOT_IN_THE_PAST,
  SLOT_RANGE_INVALID,
  SLOT_SELF_OVERLAP,
  SLOT_TAKEN,
  VENUE_CLOSED,
  VENUE_NOT_FOUND,
} from './bookings.constants';
import type { CreateLineBookingDto } from './dto/create-line-booking.dto';

const SUB = 'U0123456789abcdef0123456789abcdef';
const LINE_USER_ID = 'clx_lineuser_cuid';
const VENUE_ID = 'clx_venue_cuid';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Every fixture is an offset from the real clock: `D-C16` refuses a slot that has already begun. */
const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();

const dto = (
  slots: { startAt: string; endAt: string }[],
): CreateLineBookingDto => ({
  venueId: VENUE_ID,
  purpose: 'ประชุมเตรียมงานกีฬาสี',
  attendees: 25,
  slots,
});

const p2002 = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target },
  });

/**
 * ── WHY THE FOUR MOCKS BELOW CARRY TYPED SIGNATURES AND THE OTHER TWO DO NOT ──
 * A bare `jest.fn()` makes `mock.calls[0][0]` an `any`, and this repo's lint rules refuse to read a
 * member off one — rightly, because an assertion against `any` passes whatever the code does. Every
 * mock this file INSPECTS the arguments of is therefore declared with the shape it expects; the two
 * that are only ever asserted on with `toHaveBeenCalledWith` stay bare.
 *
 * ⚠️ THESE ARE NOT PRISMA'S REAL ARGUMENT TYPES, and must not be mistaken for them. They describe
 * only the keys these tests read. `Prisma.BookingRequestCreateArgs` would be the honest type and is
 * a deep generic union that cannot be destructured usefully; the compiler still checks the SERVICE
 * against the real one, because that is where the real client is injected.
 */
type CreateArgs = {
  data: {
    code: string;
    venueId: string;
    lineUserId?: string;
    createdById?: string;
    requesterName?: string;
    contactPhone?: string;
    departmentId?: number;
    purpose: string;
    attendees: number;
    status: BookingStatus;
    approvedById?: string;
    approvedAt?: Date;
    firstStartAt: Date;
    lastEndAt: Date;
    slots: { create: { venueId: string; startAt: Date; endAt: Date }[] };
  };
};

type CountArgs = { where: { createdAt: { gte: Date; lt: Date } } };

type SlotWhere = {
  venueId: string;
  isCancelled: boolean;
  bookingRequest:
    { status: BookingStatus } | { status: { in: readonly BookingStatus[] } };
  OR?: { startAt: { lt: Date }; endAt: { gt: Date } }[];
  startAt?: { lt: Date };
  endAt?: { gt: Date };
};

type SlotFindArgs = {
  where: SlotWhere;
  orderBy?: Record<string, 'asc' | 'desc'>[];
};

describe('BookingsService', () => {
  let service: BookingsService;

  const lineUser = { findFirst: jest.fn() };
  const venue = { findFirst: jest.fn() };
  const bookingSlot = {
    findFirst: jest.fn<any, [SlotFindArgs]>(),
    findMany: jest.fn<any, [SlotFindArgs]>(),
  };
  const bookingRequest = {
    count: jest.fn<any, [CountArgs]>(),
    create: jest.fn<any, [CreateArgs]>(),
  };
  // The interactive form: run the callback against the same mocks, so the assertions below see the
  // statements the transaction would actually issue.
  const $transaction = jest.fn((cb: (tx: unknown) => unknown) =>
    cb({ bookingSlot, bookingRequest }),
  );

  /** The happy path's collaborators, so each test overrides only the one it is about. */
  const allowAndOpen = () => {
    lineUser.findFirst.mockResolvedValue({
      id: LINE_USER_ID,
      access: AppAccess.ALLOWED,
    });
    venue.findFirst.mockResolvedValue({
      id: VENUE_ID,
      name: 'ห้องประชุมใหญ่',
      isOpen: true,
    });
    bookingSlot.findFirst.mockResolvedValue(null);
    bookingRequest.count.mockResolvedValue(0);
  };

  /** Echoes back what `create` was asked to write, so the assertions read the real arguments. */
  const echoCreate = () => {
    bookingRequest.create.mockImplementation(({ data }: CreateArgs) => ({
      id: 'clx_request_cuid',
      ...data,
      createdAt: new Date(),
      slots: data.slots.create.map((s, i) => ({
        id: `slot-${i}`,
        startAt: s.startAt,
        endAt: s.endAt,
        isCancelled: false,
      })),
    }));
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        {
          provide: PrismaService,
          useValue: {
            lineUser,
            venue,
            bookingSlot,
            bookingRequest,
            $transaction,
          },
        },
      ],
    }).compile();
    service = module.get(BookingsService);
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // POST /line-users/bookings
  // ────────────────────────────────────────────────────────────────────────────────

  describe('createFromLine', () => {
    it('creates a request and its slots in ONE transaction, PENDING, with the LIFF identity only', async () => {
      allowAndOpen();
      echoCreate();

      const result = await service.createFromLine(
        SUB,
        dto([
          { startAt: iso(DAY), endAt: iso(DAY + 2 * HOUR) },
          { startAt: iso(2 * DAY), endAt: iso(2 * DAY + 2 * HOUR) },
          { startAt: iso(3 * DAY), endAt: iso(3 * DAY + 2 * HOUR) },
        ]),
      );

      expect($transaction).toHaveBeenCalledTimes(1);
      const { data } = bookingRequest.create.mock.calls[0][0];

      // `D-C13` rule 1 — a client booking is a REQUEST. Nothing self-approves.
      expect(data.status).toBe(BookingStatus.PENDING);
      expect(data.approvedById).toBeUndefined();
      expect(data.approvedAt).toBeUndefined();

      // 🔴 `D-C18` — the LIFF origin writes `lineUserId` and none of the ADMIN origin's columns.
      // Writing `requesterName`/`contactPhone`/`departmentId` here would copy the registration into
      // a second place, free to disagree the moment the user corrects it.
      expect(data.lineUserId).toBe(LINE_USER_ID);
      expect(data.createdById).toBeUndefined();
      expect(data.requesterName).toBeUndefined();
      expect(data.contactPhone).toBeUndefined();
      expect(data.departmentId).toBeUndefined();

      // `D-C13` rule 2 — three days is three rows, not a different kind of request.
      expect(data.slots.create).toHaveLength(3);
      // The child's `venueId` is the parent's, written from one value in one transaction (the
      // schema's writer's contract, which nothing in Prisma can enforce).
      for (const slot of data.slots.create) expect(slot.venueId).toBe(VENUE_ID);

      expect(result.status).toBe(BookingStatus.PENDING);
      expect(result.venueName).toBe('ห้องประชุมใหญ่');
      expect(result.code).toMatch(/^BR-\d{8}-\d{3,}$/);
      expect(result.slots).toHaveLength(3);
    });

    it('computes firstStartAt / lastEndAt across ALL slots, whatever order they arrive in', async () => {
      allowAndOpen();
      echoCreate();

      // Deliberately out of order, and the LONGEST span is not the first or the last entry — a
      // "take slots[0] and slots[n-1]" implementation passes an ordered fixture and fails this one.
      const early = iso(DAY);
      const late = iso(9 * DAY + 5 * HOUR);
      const result = await service.createFromLine(
        SUB,
        dto([
          { startAt: iso(5 * DAY), endAt: iso(5 * DAY + HOUR) },
          { startAt: iso(9 * DAY), endAt: late },
          { startAt: early, endAt: iso(DAY + HOUR) },
        ]),
      );

      expect(result.firstStartAt.toISOString()).toBe(early);
      expect(result.lastEndAt.toISOString()).toBe(late);
      // The cache is written in the same statement as the rows it summarises.
      const { data } = bookingRequest.create.mock.calls[0][0];
      expect(data.firstStartAt.toISOString()).toBe(early);
      expect(data.lastEndAt.toISOString()).toBe(late);
    });

    it('refuses a CLOSED venue with 409, and writes nothing', async () => {
      allowAndOpen();
      venue.findFirst.mockResolvedValue({
        id: VENUE_ID,
        name: 'โรงยิม 2',
        isOpen: false,
      });

      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
        ),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        message: VENUE_CLOSED,
      });
      // The disabled CTA on the detail screen is UX; this is the boundary.
      expect($transaction).not.toHaveBeenCalled();
    });

    it('404s an unknown or soft-deleted venue', async () => {
      allowAndOpen();
      venue.findFirst.mockResolvedValue(null);

      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
        ),
      ).rejects.toThrow(new NotFoundException(VENUE_NOT_FOUND));
      // The query carries the soft-delete filter — a deleted venue is not merely hidden from the
      // list, it is unbookable.
      expect(venue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: VENUE_ID, deletedAt: null },
        }),
      );
    });

    it.each([
      ['PENDING', AppAccess.PENDING],
      ['REJECTED', AppAccess.REJECTED],
      ['BLOCKED', AppAccess.BLOCKED],
      ['UNREGISTERED', AppAccess.UNREGISTERED],
    ])(
      '403s a %s caller BEFORE looking at the venue',
      async (_label, access) => {
        lineUser.findFirst.mockResolvedValue({ id: LINE_USER_ID, access });

        await expect(
          service.createFromLine(
            SUB,
            dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
          ),
        ).rejects.toThrow(new ForbiddenException(BOOKING_NOT_ALLOWED));
        // 🔴 The ordering IS the test: a caller who is not ALLOWED must not be able to use this
        // endpoint as an existence oracle for venue ids.
        expect(venue.findFirst).not.toHaveBeenCalled();
      },
    );

    it('403s a soft-deleted (unfollowed) LINE user the same way as an absent one', async () => {
      lineUser.findFirst.mockResolvedValue(null);

      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
        ),
      ).rejects.toThrow(new ForbiddenException(BOOKING_NOT_ALLOWED));
      // 🔴 The `sub` is a LINE-side `U…` string and matches `lineUserId`, NOT the cuid `id`.
      expect(lineUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lineUserId: SUB, deletedAt: null },
        }),
      );
    });

    it('400s a slot that ends before it starts', async () => {
      allowAndOpen();
      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(2 * DAY), endAt: iso(DAY) }]),
        ),
      ).rejects.toThrow(new BadRequestException(SLOT_RANGE_INVALID));
    });

    it('400s a zero-length slot — the interval is half-open', async () => {
      allowAndOpen();
      const at = iso(DAY);
      await expect(
        service.createFromLine(SUB, dto([{ startAt: at, endAt: at }])),
      ).rejects.toThrow(new BadRequestException(SLOT_RANGE_INVALID));
    });

    it('🔴 D-C16 — 400s a slot in the past, measured against NOW rather than midnight', async () => {
      allowAndOpen();
      // An hour ago. Note that "today" is otherwise perfectly bookable, which the next case proves.
      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(-HOUR), endAt: iso(HOUR) }]),
        ),
      ).rejects.toThrow(new BadRequestException(SLOT_IN_THE_PAST));
    });

    it('🔴 D-C16 — accepts LATER TODAY, which a midnight comparison would refuse', async () => {
      allowAndOpen();
      echoCreate();
      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(2 * HOUR), endAt: iso(4 * HOUR) }]),
        ),
      ).resolves.toMatchObject({ status: BookingStatus.PENDING });
    });

    it('400s two slots of the SAME request that overlap each other', async () => {
      allowAndOpen();
      await expect(
        service.createFromLine(
          SUB,
          dto([
            { startAt: iso(DAY), endAt: iso(DAY + 3 * HOUR) },
            { startAt: iso(DAY + 2 * HOUR), endAt: iso(DAY + 4 * HOUR) },
          ]),
        ),
      ).rejects.toThrow(new BadRequestException(SLOT_SELF_OVERLAP));
    });

    it('accepts back-to-back slots — 12:00 end and 12:00 start do NOT overlap', async () => {
      allowAndOpen();
      echoCreate();
      const boundary = iso(DAY + 3 * HOUR);
      const result = await service.createFromLine(
        SUB,
        dto([
          { startAt: iso(DAY), endAt: boundary },
          { startAt: boundary, endAt: iso(DAY + 5 * HOUR) },
        ]),
      );

      expect(result.slots).toHaveLength(2);
      expect(result.slots[0].endAt).toEqual(result.slots[1].startAt);
    });

    it('409s a clash with an APPROVED slot, inside the transaction, and names nobody', async () => {
      allowAndOpen();
      bookingSlot.findFirst.mockResolvedValue({ id: 'taken-slot' });

      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
        ),
      ).rejects.toThrow(new ConflictException(SLOT_TAKEN));

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(bookingRequest.create).not.toHaveBeenCalled();
      // 🔴 APPROVED only, non-cancelled only. A PENDING clash is NOT an error (`D-C13` rule 4).
      const { where } = bookingSlot.findFirst.mock.calls[0][0];
      expect(where.bookingRequest).toEqual({ status: BookingStatus.APPROVED });
      expect(where.isCancelled).toBe(false);
      // Half-open overlap: one clause per requested slot, `start < theirEnd && end > theirStart`.
      expect(where.OR).toHaveLength(1);
      const [span] = where.OR ?? [];
      expect(span.startAt.lt).toBeInstanceOf(Date);
      expect(span.endAt.gt).toBeInstanceOf(Date);
      // The message reveals neither the holder nor their purpose (`D-C13`).
      expect(SLOT_TAKEN).not.toMatch(/who|name|purpose/i);
    });

    it('🔴 lets a PENDING clash through — several people may request the same hours', async () => {
      allowAndOpen();
      echoCreate();
      // The clash query filters to APPROVED, so a pending row simply never matches it. Encoding the
      // rule as "the query found nothing" is exactly how it behaves against a real database.
      bookingSlot.findFirst.mockResolvedValue(null);

      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
        ),
      ).resolves.toMatchObject({ status: BookingStatus.PENDING });
    });

    it('counts the day’s requests and numbers the code from that count', async () => {
      allowAndOpen();
      echoCreate();
      bookingRequest.count.mockResolvedValue(6);

      const result = await service.createFromLine(
        SUB,
        dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
      );

      expect(result.code).toMatch(/-007$/);
      // The window is a 24-hour half-open range, not "since midnight UTC".
      const { where } = bookingRequest.count.mock.calls[0][0];
      const span = where.createdAt.lt.getTime() - where.createdAt.gte.getTime();
      expect(span).toBe(DAY);
    });

    it('retries the whole transaction after losing the race for a code', async () => {
      allowAndOpen();
      echoCreate();
      bookingRequest.count
        .mockResolvedValueOnce(3) // both submissions computed -004
        .mockResolvedValueOnce(4); // the recount sees the winner's row
      bookingRequest.create.mockImplementationOnce(() => {
        throw p2002(['code']);
      });

      const result = await service.createFromLine(
        SUB,
        dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
      );

      expect(result.code).toMatch(/-005$/);
      // A NEW transaction, not a retry inside the aborted one.
      expect($transaction).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a unique violation on some other column', async () => {
      allowAndOpen();
      bookingRequest.create.mockImplementation(() => {
        throw p2002(['venueId']);
      });

      await expect(
        service.createFromLine(
          SUB,
          dto([{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }]),
        ),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
      expect($transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // GET /line-users/venues/:id/availability
  // ────────────────────────────────────────────────────────────────────────────────

  describe('listVenueAvailability', () => {
    const START = new Date('2026-09-10T02:00:00.000Z');
    const END = new Date('2026-09-10T05:00:00.000Z');

    const row = (over: Record<string, unknown> = {}) => ({
      id: 'slot-1',
      startAt: START,
      endAt: END,
      bookingRequest: {
        status: BookingStatus.APPROVED,
        purpose: 'อบรมครู',
        lineUserId: 'somebody-else',
        requesterName: null,
        lineUser: { registration: { firstName: 'สมชาย', lastName: 'ใจดี' } },
        ...over,
      },
    });

    beforeEach(() => {
      lineUser.findFirst.mockResolvedValue({
        id: LINE_USER_ID,
        access: AppAccess.ALLOWED,
      });
      venue.findFirst.mockResolvedValue({ id: VENUE_ID });
    });

    it('returns approved slots with purpose and requester resolved through the registration', async () => {
      bookingSlot.findMany.mockResolvedValue([row()]);

      const [slot] = await service.listVenueAvailability(SUB, VENUE_ID, {});

      expect(slot).toEqual({
        id: 'slot-1',
        startAt: START,
        endAt: END,
        status: BookingStatus.APPROVED,
        isMine: false,
        purpose: 'อบรมครู',
        requesterName: 'สมชาย ใจดี',
      });
    });

    it('🔴 D-C13 — blanks purpose and requester on somebody else’s PENDING slot', async () => {
      bookingSlot.findMany.mockResolvedValue([
        row({ status: BookingStatus.PENDING }),
      ]);

      const [slot] = await service.listVenueAvailability(SUB, VENUE_ID, {});

      // The slot is still returned — the calendar must show that somebody has asked (amber). What
      // it must not carry is who, or what for, and the SERVER is what omits them.
      expect(slot.status).toBe(BookingStatus.PENDING);
      expect(slot.purpose).toBeNull();
      expect(slot.requesterName).toBeNull();
    });

    it('reveals the caller’s OWN pending request to the caller', async () => {
      bookingSlot.findMany.mockResolvedValue([
        row({ status: BookingStatus.PENDING, lineUserId: LINE_USER_ID }),
      ]);

      const [slot] = await service.listVenueAvailability(SUB, VENUE_ID, {});

      expect(slot.isMine).toBe(true);
      expect(slot.purpose).toBe('อบรมครู');
    });

    it('names a staff-created booking from the override, and tolerates neither being set', async () => {
      bookingSlot.findMany.mockResolvedValue([
        row({
          lineUserId: null,
          lineUser: null,
          requesterName: 'ฝ่ายกิจการนักเรียน',
        }),
        row({ lineUserId: null, lineUser: null, requesterName: null }),
      ]);

      const slots = await service.listVenueAvailability(SUB, VENUE_ID, {});

      expect(slots[0].requesterName).toBe('ฝ่ายกิจการนักเรียน');
      // An unnamed approved slot is an internal event, not a broken row (`D-C18`).
      expect(slots[1].requesterName).toBeNull();
      expect(slots[1].isMine).toBe(false);
    });

    it('asks only for OCCUPYING, non-cancelled slots that OVERLAP the window', async () => {
      bookingSlot.findMany.mockResolvedValue([]);

      await service.listVenueAvailability(SUB, VENUE_ID, {
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      });

      const { where, orderBy } = bookingSlot.findMany.mock.calls[0][0];
      // A rejected or cancelled request still owns its rows; painting them would show a free room
      // as taken.
      expect(where.bookingRequest).toEqual({
        status: { in: [BookingStatus.APPROVED, BookingStatus.PENDING] },
      });
      expect(where.isCancelled).toBe(false);
      // 🔴 OVERLAP, not containment — a camp that began before `from` still occupies day one.
      expect(where.startAt).toEqual({
        lt: new Date('2026-10-01T00:00:00.000Z'),
      });
      expect(where.endAt).toEqual({ gt: new Date('2026-09-01T00:00:00.000Z') });
      expect(orderBy).toEqual([{ startAt: 'asc' }, { id: 'asc' }]);
    });

    it('defaults to a one-month window when from/to are omitted', async () => {
      bookingSlot.findMany.mockResolvedValue([]);

      await service.listVenueAvailability(SUB, VENUE_ID, {});

      const { where } = bookingSlot.findMany.mock.calls[0][0];
      const days =
        ((where.startAt?.lt.getTime() ?? 0) -
          (where.endAt?.gt.getTime() ?? 0)) /
        DAY;
      expect(days).toBeGreaterThanOrEqual(28);
      expect(days).toBeLessThanOrEqual(31);
    });

    it('400s a reversed range and one wider than a year', async () => {
      await expect(
        service.listVenueAvailability(SUB, VENUE_ID, {
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-09-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.listVenueAvailability(SUB, VENUE_ID, {
          from: '2020-01-01T00:00:00.000Z',
          to: '2030-01-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(bookingSlot.findMany).not.toHaveBeenCalled();
    });

    it('404s an unknown venue rather than returning an empty calendar', async () => {
      venue.findFirst.mockResolvedValue(null);

      await expect(
        service.listVenueAvailability(SUB, VENUE_ID, {}),
      ).rejects.toThrow(new NotFoundException(VENUE_NOT_FOUND));
      expect(bookingSlot.findMany).not.toHaveBeenCalled();
    });

    it('403s a caller who is not ALLOWED, before the venue lookup', async () => {
      lineUser.findFirst.mockResolvedValue({
        id: LINE_USER_ID,
        access: AppAccess.PENDING,
      });

      await expect(
        service.listVenueAvailability(SUB, VENUE_ID, {}),
      ).rejects.toThrow(new ForbiddenException(BOOKING_NOT_ALLOWED));
      expect(venue.findFirst).not.toHaveBeenCalled();
    });
  });
});
