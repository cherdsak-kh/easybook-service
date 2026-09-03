import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppAccess, BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingsService } from './bookings.service';
import {
  BOOKING_NOT_ALLOWED,
  BOOKING_NOT_APPROVED,
  BOOKING_NOT_FOUND,
  BOOKING_NOT_PENDING,
  CANCEL_LEAD_MINUTES_DEFAULT,
  CANCEL_LEAD_MINUTES_KEY,
  CANCELLED_BY_LINE_USER,
  SLOT_ALREADY_CANCELLED,
  SLOT_CANCEL_TOO_LATE,
  SLOT_IN_THE_PAST,
  SLOT_NOT_FOUND,
  SLOT_RANGE_INVALID,
  SLOT_SELF_OVERLAP,
  SLOT_TAKEN,
  VENUE_CLOSED,
  VENUE_NOT_FOUND,
} from './bookings.constants';
import type { CreateLineBookingDto } from './dto/create-line-booking.dto';
import {
  BOOKING_SORT_DEFAULT,
  type ListLineBookingsQueryDto,
} from './dto/list-line-bookings-query.dto';

const SUB = 'U0123456789abcdef0123456789abcdef';
const LINE_USER_ID = 'clx_lineuser_cuid';
const VENUE_ID = 'clx_venue_cuid';
const BOOKING_ID = 'clx_request_cuid';
const SLOT_ID = 'clx_slot_cuid';
const CODE = 'BR-25690903-001';

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

/**
 * ⚠️ EVERY KEY IS OPTIONAL because ONE mock serves several queries — the availability read, the
 * approved-clash check, and Phase 6a's slot lookups all land on `bookingSlot.findFirst`/`findMany`
 * with different `where` shapes. Requiring a key here would type-error the reads that legitimately
 * omit it, and widening the mock is cheaper than three mocks that could drift apart.
 */
type SlotWhere = {
  venueId?: string;
  id?: string;
  bookingRequestId?: string;
  isCancelled?: boolean;
  bookingRequest?:
    { status: BookingStatus } | { status: { in: readonly BookingStatus[] } };
  OR?: { startAt: { lt: Date }; endAt: { gt: Date } }[];
  startAt?: { lt: Date };
  endAt?: { gt: Date };
};

type SlotFindArgs = {
  where: SlotWhere;
  orderBy?: Record<string, 'asc' | 'desc'>[];
};

/** `findMany` on the My Bookings list — the ownership clause is what these tests read. */
type BookingListArgs = {
  where: {
    lineUserId: string;
    status?: BookingStatus;
    OR?: Record<string, unknown>[];
  };
  orderBy: Record<string, 'asc' | 'desc'>[];
};

/** `findFirst` on a booking, by id-or-code and owner. `include` marks the DETAIL read. */
type BookingFindArgs = {
  where: {
    lineUserId?: string;
    id?: string;
    OR?: { id?: string; code?: string }[];
  };
  include?: unknown;
};

type BookingUpdateManyArgs = {
  where: { id: string; status: BookingStatus };
  data: { status: BookingStatus };
};

type BookingUpdateArgs = {
  where: { id: string };
  data: { status?: BookingStatus; firstStartAt?: Date; lastEndAt?: Date };
};

type SlotUpdateManyArgs = {
  where: { bookingRequestId?: string; id?: string; isCancelled: boolean };
  data: {
    isCancelled: boolean;
    cancelledAt: Date;
    cancelledById: string;
    cancelledByRole: string;
  };
};

describe('BookingsService', () => {
  let service: BookingsService;

  const lineUser = { findFirst: jest.fn() };
  const venue = { findFirst: jest.fn() };
  const bookingSlot = {
    findFirst: jest.fn<any, [SlotFindArgs]>(),
    findMany: jest.fn<any, [SlotFindArgs]>(),
    updateMany: jest.fn<any, [SlotUpdateManyArgs]>(),
  };
  const bookingRequest = {
    count: jest.fn<any, [CountArgs]>(),
    create: jest.fn<any, [CreateArgs]>(),
    findMany: jest.fn<any, [BookingListArgs]>(),
    findFirst: jest.fn<any, [BookingFindArgs]>(),
    updateMany: jest.fn<any, [BookingUpdateManyArgs]>(),
    update: jest.fn<any, [BookingUpdateArgs]>(),
  };
  const appSetting = { findUnique: jest.fn() };
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
        cancelledAt: null,
        cancelReason: null,
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
            appSetting,
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

  // ════════════════════════════════════════════════════════════════════════════════
  // Phase 6a — My Bookings, the detail read, and the two cancellations
  // ════════════════════════════════════════════════════════════════════════════════

  const allow = () =>
    lineUser.findFirst.mockResolvedValue({
      id: LINE_USER_ID,
      access: AppAccess.ALLOWED,
    });

  /** A row shaped like `DETAIL_INCLUDE`'s payload. `include` returns every scalar, `approvedById` included. */
  const detailRow = (over: Record<string, unknown> = {}) => ({
    id: BOOKING_ID,
    code: CODE,
    venue: {
      id: VENUE_ID,
      name: 'ห้องประชุมใหญ่',
      location: 'อาคารเรียนรวม ชั้น 3',
      capacity: 40,
      isOpen: true,
      venueType: { id: 4, name: 'ห้องประชุม', isSystemReserved: false },
      photos: [{ id: 'p1', url: 'https://cdn.example.com/1.jpg', position: 0 }],
      amenities: [{ amenity: { id: 1, name: 'โปรเจกเตอร์' } }],
    },
    purpose: 'ประชุมเตรียมงานกีฬาสี',
    attendees: 10,
    status: BookingStatus.PENDING,
    rejectReason: null,
    firstStartAt: new Date(Date.now() + DAY),
    lastEndAt: new Date(Date.now() + DAY + HOUR),
    approvedAt: null,
    // 🔴 Present on the ROW and expected to be absent from the DTO — see the leak test below.
    approvedById: 'clx_staff_cuid',
    slots: [],
    createdAt: new Date(),
    ...over,
  });

  /**
   * ⚠️ ONE MOCK, TWO CALLERS. `bookingRequest.findFirst` is issued inside the transaction for the
   * state check (`select`, no relations) and again afterwards for the response (`include`). The
   * dispatch is on `include`, so a test never has to count calls in order — which would silently
   * pass if a future refactor reordered them.
   */
  const answerFindFirst = (
    light: unknown,
    detail: unknown = detailRow(),
  ): void => {
    bookingRequest.findFirst.mockImplementation((args: BookingFindArgs) =>
      args.include ? detail : light,
    );
  };

  const query = (
    over: Partial<ListLineBookingsQueryDto> = {},
  ): ListLineBookingsQueryDto => ({ sort: BOOKING_SORT_DEFAULT, ...over });

  describe('listUserBookings', () => {
    beforeEach(() => {
      allow();
      bookingRequest.findMany.mockResolvedValue([]);
    });

    it('scopes the query to the caller and defaults to newest-submitted first', async () => {
      await service.listUserBookings(SUB, query());

      const { where, orderBy } = bookingRequest.findMany.mock.calls[0][0];
      // 🔴 Ownership is a `where` clause, never a filter applied after the read.
      expect(where.lineUserId).toBe(LINE_USER_ID);
      expect(where.status).toBeUndefined();
      expect(where.OR).toBeUndefined();
      expect(orderBy).toEqual([{ createdAt: 'desc' }, { code: 'asc' }]);
    });

    it('strips a leading # and searches the code, purpose, venue name and location', async () => {
      await service.listUserBookings(SUB, query({ q: `  #${CODE}  ` }));

      const { where } = bookingRequest.findMany.mock.calls[0][0];
      // The user pasted `#BR-…` out of a LINE chat; the row stores it without the hash.
      expect(where.OR).toEqual([
        { code: { contains: CODE, mode: 'insensitive' } },
        { purpose: { contains: CODE, mode: 'insensitive' } },
        { venue: { name: { contains: CODE, mode: 'insensitive' } } },
        { venue: { location: { contains: CODE, mode: 'insensitive' } } },
      ]);
      // 🔴 The search never widens past its author.
      expect(where.lineUserId).toBe(LINE_USER_ID);
    });

    it('emits no search clause at all for a blank q', async () => {
      await service.listUserBookings(SUB, query({ q: '   ' }));

      expect(bookingRequest.findMany.mock.calls[0][0].where.OR).toBeUndefined();
    });

    it('passes a status filter through as the STORED status', async () => {
      await service.listUserBookings(
        SUB,
        query({ status: BookingStatus.REJECTED }),
      );

      expect(bookingRequest.findMany.mock.calls[0][0].where.status).toBe(
        BookingStatus.REJECTED,
      );
    });

    it('maps each sort to its own column, always tie-breaking on code', async () => {
      // 🔴 TWO DIMENSIONS OF TIME: `created-*` is when it was SUBMITTED, `event-*` when the room is
      // USED. Reading `firstStartAt` for a `created-*` sort would order a March booking submitted
      // today next to one submitted in March, and nothing on screen would look wrong.
      const expected = {
        'created-desc': [{ createdAt: 'desc' }, { code: 'asc' }],
        'created-asc': [{ createdAt: 'asc' }, { code: 'asc' }],
        'event-asc': [{ firstStartAt: 'asc' }, { code: 'asc' }],
        'event-desc': [{ firstStartAt: 'desc' }, { code: 'asc' }],
      } as const;

      for (const [sort, orderBy] of Object.entries(expected)) {
        bookingRequest.findMany.mockClear();
        await service.listUserBookings(
          SUB,
          query({ sort } as Partial<ListLineBookingsQueryDto>),
        );
        expect(bookingRequest.findMany.mock.calls[0][0].orderBy).toEqual(
          orderBy,
        );
      }
    });

    it('403s a caller who is not ALLOWED, before any booking is read', async () => {
      lineUser.findFirst.mockResolvedValue({
        id: LINE_USER_ID,
        access: AppAccess.BLOCKED,
      });

      await expect(service.listUserBookings(SUB, query())).rejects.toThrow(
        new ForbiddenException(BOOKING_NOT_ALLOWED),
      );
      expect(bookingRequest.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getUserBookingDetail', () => {
    beforeEach(() => {
      allow();
      appSetting.findUnique.mockResolvedValue({ value: '30' });
      answerFindFirst(null);
    });

    it('resolves a cuid and a code through ONE query, scoped to the owner', async () => {
      await service.getUserBookingDetail(SUB, BOOKING_ID);

      const { where } = bookingRequest.findFirst.mock.calls[0][0];
      expect(where.lineUserId).toBe(LINE_USER_ID);
      expect(where.OR).toEqual([{ id: BOOKING_ID }, { code: BOOKING_ID }]);
    });

    it('strips a leading # so a pasted #BR-… resolves', async () => {
      await service.getUserBookingDetail(SUB, ` #${CODE} `);

      expect(bookingRequest.findFirst.mock.calls[0][0].where.OR).toEqual([
        { id: CODE },
        { code: CODE },
      ]);
    });

    it('404s somebody else’s booking — never 403, because `code` is guessable', async () => {
      bookingRequest.findFirst.mockResolvedValue(null);

      await expect(service.getUserBookingDetail(SUB, CODE)).rejects.toThrow(
        new NotFoundException(BOOKING_NOT_FOUND),
      );
    });

    it('returns the venue and slots, and never the approver’s identity', async () => {
      answerFindFirst(
        null,
        detailRow({
          slots: [
            {
              id: SLOT_ID,
              startAt: new Date(Date.now() + DAY),
              endAt: new Date(Date.now() + DAY + HOUR),
              isCancelled: true,
              cancelledAt: new Date(),
              cancelReason: null,
            },
          ],
          status: BookingStatus.APPROVED,
          approvedAt: new Date(),
        }),
      );

      const result = await service.getUserBookingDetail(SUB, BOOKING_ID);

      expect(result.venue.name).toBe('ห้องประชุมใหญ่');
      expect(result.venue.amenities).toEqual([{ id: 1, name: 'โปรเจกเตอร์' }]);
      expect(result.venue.venueType.isFallback).toBe(false);
      // ⚠️ A cancelled slot STAYS on the owner's own detail — the calendar hides it, the receipt
      // must not, or a three-day request silently becomes a two-day one.
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0].isCancelled).toBe(true);
      expect(result.approvedAt).toBeInstanceOf(Date);
      // 🔴 Ruled on, and by whom is not the requester's business.
      expect(result).not.toHaveProperty('approvedById');
    });

    it('carries the lead time from app_settings, not from the constant', async () => {
      appSetting.findUnique.mockResolvedValue({ value: '120' });

      const result = await service.getUserBookingDetail(SUB, BOOKING_ID);

      expect(appSetting.findUnique).toHaveBeenCalledWith({
        where: { key: CANCEL_LEAD_MINUTES_KEY },
        select: { value: true },
      });
      expect(result.cancelLeadMinutes).toBe(120);
    });

    it('falls back to the documented default when the setting is missing or garbage', async () => {
      // A missing row must not take the cancel button away from every user at once.
      appSetting.findUnique.mockResolvedValue(null);
      expect(
        (await service.getUserBookingDetail(SUB, CODE)).cancelLeadMinutes,
      ).toBe(CANCEL_LEAD_MINUTES_DEFAULT);

      appSetting.findUnique.mockResolvedValue({ value: 'สามสิบ' });
      expect(
        (await service.getUserBookingDetail(SUB, CODE)).cancelLeadMinutes,
      ).toBe(CANCEL_LEAD_MINUTES_DEFAULT);
    });
  });

  describe('cancelPendingBooking', () => {
    beforeEach(() => {
      allow();
      appSetting.findUnique.mockResolvedValue({ value: '30' });
      bookingRequest.updateMany.mockResolvedValue({ count: 1 });
      bookingSlot.updateMany.mockResolvedValue({ count: 3 });
    });

    it('flips the request and EVERY live slot in one transaction, stamping the actor', async () => {
      answerFindFirst(
        { id: BOOKING_ID, status: BookingStatus.PENDING },
        detailRow({ status: BookingStatus.CANCELLED }),
      );

      const result = await service.cancelPendingBooking(SUB, CODE);

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(bookingRequest.updateMany.mock.calls[0][0].data).toEqual({
        status: BookingStatus.CANCELLED,
      });

      // `Q-C4` ②: the truth lives at slot level. A cancelled parent over live children is a row the
      // venue calendar still paints.
      const slotWrite = bookingSlot.updateMany.mock.calls[0][0];
      expect(slotWrite.where).toEqual({
        bookingRequestId: BOOKING_ID,
        isCancelled: false,
      });
      // 🔴 The flag and the timestamp are a PAIR; `cancelledByRole` is what says which table
      // `cancelledById` points into.
      expect(slotWrite.data.isCancelled).toBe(true);
      expect(slotWrite.data.cancelledAt).toBeInstanceOf(Date);
      expect(slotWrite.data.cancelledById).toBe(LINE_USER_ID);
      expect(slotWrite.data.cancelledByRole).toBe(CANCELLED_BY_LINE_USER);

      expect(result.status).toBe(BookingStatus.CANCELLED);
    });

    it('makes the state check a CONDITIONAL update, not just the preceding if', async () => {
      answerFindFirst({ id: BOOKING_ID, status: BookingStatus.PENDING });

      await service.cancelPendingBooking(SUB, BOOKING_ID);

      // Two taps on a phone both pass the `if`; only one can pass this `where`.
      expect(bookingRequest.updateMany.mock.calls[0][0].where).toEqual({
        id: BOOKING_ID,
        status: BookingStatus.PENDING,
      });
    });

    it('422s when the conditional update loses the race, and writes no slots', async () => {
      answerFindFirst({ id: BOOKING_ID, status: BookingStatus.PENDING });
      bookingRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancelPendingBooking(SUB, CODE)).rejects.toThrow(
        new UnprocessableEntityException(BOOKING_NOT_PENDING),
      );
      expect(bookingSlot.updateMany).not.toHaveBeenCalled();
    });

    it('422s an APPROVED, REJECTED or CANCELLED request and writes nothing', async () => {
      for (const status of [
        BookingStatus.APPROVED,
        BookingStatus.REJECTED,
        BookingStatus.CANCELLED,
      ]) {
        bookingRequest.updateMany.mockClear();
        bookingSlot.updateMany.mockClear();
        answerFindFirst({ id: BOOKING_ID, status });

        await expect(service.cancelPendingBooking(SUB, CODE)).rejects.toThrow(
          new UnprocessableEntityException(BOOKING_NOT_PENDING),
        );
        expect(bookingRequest.updateMany).not.toHaveBeenCalled();
        expect(bookingSlot.updateMany).not.toHaveBeenCalled();
      }
    });

    it('404s an unknown or foreign booking', async () => {
      answerFindFirst(null);

      await expect(service.cancelPendingBooking(SUB, CODE)).rejects.toThrow(
        new NotFoundException(BOOKING_NOT_FOUND),
      );
      expect(bookingRequest.updateMany).not.toHaveBeenCalled();
    });

    it('leaves firstStartAt/lastEndAt alone — history still needs a date to sort by', async () => {
      answerFindFirst({ id: BOOKING_ID, status: BookingStatus.PENDING });

      await service.cancelPendingBooking(SUB, BOOKING_ID);

      expect(bookingRequest.update).not.toHaveBeenCalled();
    });
  });

  describe('cancelApprovedSlot', () => {
    // ⚠️ FROZEN, not `Date.now()` per call. The first version of this file built the fixture and
    // the expectation from two separate clock reads and failed by one millisecond — a real bug in
    // the test, and exactly the kind that gets "fixed" by loosening the assertion instead.
    const BASE = Date.now();
    const inDays = (d: number) => new Date(BASE + d * DAY);

    /** An APPROVED booking whose named slot starts `startsInMs` from now. */
    const approvedWithSlot = (startsInMs: number, isCancelled = false) => {
      answerFindFirst(
        { id: BOOKING_ID, status: BookingStatus.APPROVED },
        detailRow({ status: BookingStatus.APPROVED }),
      );
      bookingSlot.findFirst.mockResolvedValue({
        id: SLOT_ID,
        startAt: new Date(Date.now() + startsInMs),
        isCancelled,
      });
    };

    beforeEach(() => {
      allow();
      appSetting.findUnique.mockResolvedValue({ value: '30' });
      bookingSlot.updateMany.mockResolvedValue({ count: 1 });
      bookingSlot.findMany.mockResolvedValue([]);
      bookingRequest.update.mockResolvedValue({});
    });

    it('422s a slot inside the lead time and writes nothing', async () => {
      // 29 minutes out, lead time 30 — refused. 🔴 This is the boundary; the hidden button is UX.
      approvedWithSlot(29 * 60_000);

      await expect(
        service.cancelApprovedSlot(SUB, CODE, SLOT_ID),
      ).rejects.toThrow(new UnprocessableEntityException(SLOT_CANCEL_TOO_LATE));
      expect(bookingSlot.updateMany).not.toHaveBeenCalled();
      expect(bookingRequest.update).not.toHaveBeenCalled();
    });

    it('422s a slot that has already started', async () => {
      approvedWithSlot(-HOUR);

      await expect(
        service.cancelApprovedSlot(SUB, CODE, SLOT_ID),
      ).rejects.toThrow(new UnprocessableEntityException(SLOT_CANCEL_TOO_LATE));
    });

    it('reads the lead time from app_settings, so a wider window refuses a slot 30 held', async () => {
      // The same slot the default would have allowed. If this passed, the setting would be decorative.
      appSetting.findUnique.mockResolvedValue({ value: '180' });
      approvedWithSlot(2 * HOUR);

      await expect(
        service.cancelApprovedSlot(SUB, CODE, SLOT_ID),
      ).rejects.toThrow(new UnprocessableEntityException(SLOT_CANCEL_TOO_LATE));
    });

    it('cancels ONLY that slot and recomputes the span over what remains', async () => {
      approvedWithSlot(3 * DAY);
      bookingSlot.findMany.mockResolvedValue([
        { startAt: inDays(5), endAt: inDays(5.1) },
        { startAt: inDays(1), endAt: inDays(1.2) },
      ]);

      await service.cancelApprovedSlot(SUB, BOOKING_ID, SLOT_ID);

      // Targeted by id, and guarded by `isCancelled: false` so a double-tap cannot restamp it.
      const slotWrite = bookingSlot.updateMany.mock.calls[0][0];
      expect(slotWrite.where).toEqual({ id: SLOT_ID, isCancelled: false });
      expect(slotWrite.data.cancelledById).toBe(LINE_USER_ID);
      expect(slotWrite.data.cancelledByRole).toBe(CANCELLED_BY_LINE_USER);

      // ⚠️ The denormalised pair is a CACHE of the children; stale, it mis-sorts rather than errors.
      // Note the fixture is deliberately out of order — min/max, not first/last.
      const { data } = bookingRequest.update.mock.calls[0][0];
      expect(data.status).toBeUndefined();
      expect(data.firstStartAt).toEqual(inDays(1));
      expect(data.lastEndAt).toEqual(inDays(5.1));
    });

    it('flips the whole request to CANCELLED when the last live slot goes', async () => {
      approvedWithSlot(3 * DAY);
      bookingSlot.findMany.mockResolvedValue([]);

      await service.cancelApprovedSlot(SUB, BOOKING_ID, SLOT_ID);

      // 🔴 `Q-C4` ②: the request's status is DERIVED from its slots. An APPROVED booking with
      // nothing live would sit in the approved accordion looking like it is still happening.
      const { data } = bookingRequest.update.mock.calls[0][0];
      expect(data.status).toBe(BookingStatus.CANCELLED);
      // The span is left exactly as it was, so the history group still has a date to sort by.
      // ⚠️ "As it was", not "as it originally was": a request cancelled slot by slot ends up with
      // the window of whichever slot went last. There is no aggregate over zero live slots.
      expect(data.firstStartAt).toBeUndefined();
      expect(data.lastEndAt).toBeUndefined();
    });

    it('422s when the booking is not APPROVED — a pending one is cancelled whole', async () => {
      answerFindFirst({ id: BOOKING_ID, status: BookingStatus.PENDING });

      await expect(
        service.cancelApprovedSlot(SUB, CODE, SLOT_ID),
      ).rejects.toThrow(new UnprocessableEntityException(BOOKING_NOT_APPROVED));
      expect(bookingSlot.findFirst).not.toHaveBeenCalled();
    });

    it('404s a slot id that belongs to another booking', async () => {
      answerFindFirst({ id: BOOKING_ID, status: BookingStatus.APPROVED });
      bookingSlot.findFirst.mockResolvedValue(null);

      await expect(
        service.cancelApprovedSlot(SUB, CODE, 'clx_someone_elses_slot'),
      ).rejects.toThrow(new NotFoundException(SLOT_NOT_FOUND));

      // The lookup is scoped to the parent, so a stranger's Tuesday is never even a candidate.
      expect(bookingSlot.findFirst.mock.calls[0][0].where).toEqual({
        id: 'clx_someone_elses_slot',
        bookingRequestId: BOOKING_ID,
      });
    });

    it('422s an already-cancelled slot rather than restamping it', async () => {
      approvedWithSlot(3 * DAY, true);

      await expect(
        service.cancelApprovedSlot(SUB, CODE, SLOT_ID),
      ).rejects.toThrow(
        new UnprocessableEntityException(SLOT_ALREADY_CANCELLED),
      );
      expect(bookingSlot.updateMany).not.toHaveBeenCalled();
    });

    it('422s when the guarded slot update loses the race', async () => {
      approvedWithSlot(3 * DAY);
      bookingSlot.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.cancelApprovedSlot(SUB, CODE, SLOT_ID),
      ).rejects.toThrow(
        new UnprocessableEntityException(SLOT_ALREADY_CANCELLED),
      );
      expect(bookingRequest.update).not.toHaveBeenCalled();
    });

    it('404s an unknown booking before it looks at any slot', async () => {
      answerFindFirst(null);

      await expect(
        service.cancelApprovedSlot(SUB, CODE, SLOT_ID),
      ).rejects.toThrow(new NotFoundException(BOOKING_NOT_FOUND));
      expect(bookingSlot.findFirst).not.toHaveBeenCalled();
    });
  });
});
