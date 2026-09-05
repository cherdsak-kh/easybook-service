import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppAccess, BookingStatus, SystemRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AdminBookingsService } from './admin-bookings.service';
import {
  AUTO_REJECTED_REASON,
  BOOKING_ALREADY_CANCELLED,
  BOOKING_NOT_APPROVED_FOR_CANCEL,
  BOOKING_NOT_FOUND,
  BOOKING_NOT_PENDING_FOR_DECISION,
  BOOKING_DECISION_RACE,
  INVALID_DEPARTMENT,
  INVALID_LINE_USER,
  SLOT_ALREADY_CANCELLED,
  SLOT_NOT_ON_THIS_BOOKING,
  SLOT_TAKEN,
  VENUE_NOT_FOUND,
} from './bookings.constants';
import type {
  BookingPreflightDto,
  CreateDirectBookingDto,
} from './dto/admin-booking-write.dto';
import {
  BOOKING_REQUEST_SORT_DEFAULT,
  type BookingRequestSort,
  type ListBookingRequestsQueryDto,
} from './dto/list-booking-requests-query.dto';

const VENUE_ID = 'clx_venue_cuid';
const BOOKING_ID = 'clx_request_cuid';
const LOSER_ID = 'clx_loser_cuid';
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * ⚠️ IT CARRIES A `name` SINCE `ADMIN-REALTIME-BOOKINGS-1`. The realtime event answers "who just did
 * that?", so the actor had to widen from `{ id, role }`; `role` is still the only half any WRITE
 * reads. The Thai display name is deliberate — the emit assertions check it reaches the socket and
 * the PII assertions check it never reaches a log line.
 */
const ACTOR = {
  id: 'clx_staff_cuid',
  name: 'วีระ ทองดี',
  role: SystemRole.ADMIN,
};

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const at = (msFromNow: number) => new Date(Date.now() + msFromNow);

/** The measured `DriverAdapterError` shape for a Postgres error surfaced through the pg adapter. */
const driverError = (code: string) => {
  const err = new Error(`sqlstate ${code}`) as Error & { cause?: unknown };
  err.cause = { code, originalCode: code };
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

describe('AdminBookingsService', () => {
  let service: AdminBookingsService;

  const bookingRequest = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const bookingSlot = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    // `count`, not `findFirst`, is what the shared conflict core uses — the banner has a NUMBER in
    // it, and `findApprovedClash` only ever returns the first hit.
    count: jest.fn(),
    updateMany: jest.fn(),
  };
  const venue = { findFirst: jest.fn() };
  const lineUser = { findFirst: jest.fn() };
  const department = { findFirst: jest.fn() };
  const $executeRaw = jest.fn();

  /**
   * The gateway is MOCKED, never the socket. `RealtimeGateway`'s own fail-soft behaviour is its
   * spec's job; what this file measures is WHICH rows this service announces, and when.
   */
  const realtime = {
    emitBookingRequestCreated: jest.fn(),
    emitBookingRequestUpdated: jest.fn(),
  };

  const tx = {
    bookingRequest,
    bookingSlot,
    venue,
    lineUser,
    department,
    $executeRaw,
  };

  /** The interactive form: the callback runs against the same mocks the assertions read. */
  const $transaction = jest.fn((cb: (client: unknown) => unknown) => cb(tx));

  /** A settled row for the detail read every write path ends with. */
  const detailRow = (over: Record<string, unknown> = {}) => ({
    id: BOOKING_ID,
    code: 'BR-25690903-001',
    status: BookingStatus.APPROVED,
    createdById: null,
    purpose: 'ประชุม',
    attendees: 10,
    firstStartAt: at(DAY),
    lastEndAt: at(DAY + HOUR),
    rejectReason: null,
    createdAt: at(-DAY),
    requesterName: null,
    contactPhone: null,
    department: null,
    lineUser: null,
    venueId: VENUE_ID,
    approvedAt: null,
    venue: {
      id: VENUE_ID,
      name: 'หอประชุม',
      location: null,
      capacity: 100,
      isOpen: true,
    },
    createdBy: null,
    approvedBy: null,
    slots: [
      {
        id: 'slot-1',
        startAt: at(DAY),
        endAt: at(DAY + HOUR),
        isCancelled: false,
        cancelledAt: null,
        cancelReason: null,
        cancelledByRole: null,
      },
    ],
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    $executeRaw.mockResolvedValue(1);
    // The realtime re-read (`readBookingListDtos`) lands on this delegate AFTER every write path
    // commits. Defaulting it to "no rows" keeps the tests that are not about the fan-out silent —
    // a test that IS about it queues its own rows with `mockResolvedValueOnce`.
    bookingRequest.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminBookingsService,
        {
          provide: PrismaService,
          useValue: {
            bookingRequest,
            bookingSlot,
            venue,
            lineUser,
            department,
            $transaction,
            $executeRaw,
          },
        },
        { provide: RealtimeGateway, useValue: realtime },
      ],
    }).compile();
    service = module.get(AdminBookingsService);
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // GET /booking-requests — AC-BR2, AC-BR3, AC-BR4
  // ────────────────────────────────────────────────────────────────────────────────
  describe('list', () => {
    /** The shape `ValidationPipe` hands the service: defaults already applied. */
    const query = (
      over: Partial<ListBookingRequestsQueryDto> = {},
    ): ListBookingRequestsQueryDto => ({
      page: 1,
      limit: 10,
      sort: BOOKING_REQUEST_SORT_DEFAULT,
      ...over,
    });

    beforeEach(() => {
      bookingRequest.findMany.mockResolvedValue([]);
      bookingRequest.count.mockResolvedValue(0);
      bookingRequest.groupBy.mockResolvedValue([]);
    });

    it('paginates and sorts AT THE SERVER, with `code` as the total-order tiebreak', async () => {
      await service.list(query({ page: 3, limit: 20, sort: 'event-asc' }));
      const args = callArg<{
        skip: number;
        take: number;
        orderBy: unknown;
      }>(bookingRequest.findMany);
      expect(args.skip).toBe(40);
      expect(args.take).toBe(20);
      // 🔴 `firstStartAt` — an indexed SCALAR, never an aggregate and never `slots[0]` (AC-BR4).
      expect(args.orderBy).toEqual([{ firstStartAt: 'asc' }, { code: 'asc' }]);
    });

    it.each([
      ['created-desc', [{ createdAt: 'desc' }, { code: 'asc' }]],
      ['created-asc', [{ createdAt: 'asc' }, { code: 'asc' }]],
      ['event-asc', [{ firstStartAt: 'asc' }, { code: 'asc' }]],
      ['event-desc', [{ firstStartAt: 'desc' }, { code: 'asc' }]],
    ])(
      'resolves sort=%s and always breaks ties on code',
      async (sort, expected) => {
        await service.list(query({ sort: sort as BookingRequestSort }));
        const args = callArg<{
          orderBy: unknown;
        }>(bookingRequest.findMany);
        expect(args.orderBy).toEqual(expected);
      },
    );

    it('searches the code, purpose, venue name AND both sources of the requester name', async () => {
      await service.list(query({ search: '#somchai' }));
      const args = callArg<{
        where: { OR?: Record<string, unknown>[] };
      }>(bookingRequest.findMany);
      const keys = (args.where.OR ?? []).map((c) => Object.keys(c)[0]);
      expect(keys).toEqual([
        'code',
        'purpose',
        'venue',
        'requesterName',
        'lineUser',
        'lineUser',
      ]);
      // The leading `#` is stripped: staff paste the number exactly as LINE printed it.
      expect(JSON.stringify(args.where)).toContain('somchai');
      expect(JSON.stringify(args.where)).not.toContain('#somchai');
    });

    it('adds NO clause at all for a blank search — never `contains: ""`', async () => {
      await service.list(query({ search: '   ' }));
      const args = callArg<{
        where: Record<string, unknown>;
      }>(bookingRequest.findMany);
      expect(args.where.OR).toBeUndefined();
    });

    /**
     * 🔴 THE TAB COUNTS IGNORE THE SELECTED TAB. Counting under `status` would zero the other four
     * the moment one is picked — a bug the screen cannot tell from real data.
     */
    it('counts under search+venue but NOT under status, and zero-fills missing statuses', async () => {
      bookingRequest.groupBy.mockResolvedValue([
        { status: BookingStatus.PENDING, _count: { _all: 2 } },
        { status: BookingStatus.APPROVED, _count: { _all: 5 } },
      ]);
      const result = await service.list(
        query({ status: BookingStatus.APPROVED, venueId: VENUE_ID }),
      );

      const groupArgs = callArg<{
        where: Record<string, unknown>;
      }>(bookingRequest.groupBy);
      expect(groupArgs.where.venueId).toBe(VENUE_ID);
      expect(groupArgs.where.status).toBeUndefined();

      const listArgs = callArg<{
        where: Record<string, unknown>;
      }>(bookingRequest.findMany);
      expect(listArgs.where.status).toBe(BookingStatus.APPROVED);

      expect(result.counts).toEqual({
        all: 7,
        pending: 2,
        approved: 5,
        rejected: 0,
        cancelled: 0,
      });
    });

    it('computes `isExpired` at read time — PENDING and already over', async () => {
      bookingRequest.findMany.mockResolvedValue([
        detailRow({
          status: BookingStatus.PENDING,
          lastEndAt: at(-HOUR),
        }),
        detailRow({
          id: 'future',
          status: BookingStatus.PENDING,
          lastEndAt: at(DAY),
        }),
        // An APPROVED booking in the past is `สิ้นสุดแล้ว`, not `หมดอายุ` — never `isExpired`.
        detailRow({
          id: 'done',
          status: BookingStatus.APPROVED,
          lastEndAt: at(-HOUR),
        }),
      ]);
      const result = await service.list(query());
      expect(result.data.map((r) => r.isExpired)).toEqual([true, false, false]);
    });

    it('infers `origin` from `createdById` — ADMIN wins even when a LINE user is attached', async () => {
      bookingRequest.findMany.mockResolvedValue([
        detailRow({ createdById: null }),
        detailRow({ id: 'b', createdById: ACTOR.id }),
      ]);
      const result = await service.list(query());
      expect(result.data.map((r) => r.origin)).toEqual(['LINE', 'ADMIN']);
    });

    it('resolves the requester from the REGISTRATION when there is one, else the overrides', async () => {
      bookingRequest.findMany.mockResolvedValue([
        detailRow({
          lineUser: {
            registration: {
              firstName: 'สมชาย',
              lastName: 'ใจดี',
              phone: '081-234-5678',
              department: { name: 'ฝ่ายวิชาการ' },
            },
          },
        }),
        detailRow({
          id: 'b',
          requesterName: 'สพท.',
          contactPhone: '02-000-0000',
          department: { name: 'ภายนอก' },
        }),
      ]);
      const result = await service.list(query());
      expect(result.data[0].requester).toEqual({
        name: 'สมชาย ใจดี',
        phone: '081-234-5678',
        departmentName: 'ฝ่ายวิชาการ',
      });
      expect(result.data[1].requester).toEqual({
        name: 'สพท.',
        phone: '02-000-0000',
        departmentName: 'ภายนอก',
      });
    });

    it('never leaks `holdsSlot` or `cancelledById` into a slot DTO', async () => {
      bookingRequest.findMany.mockResolvedValue([detailRow()]);
      const result = await service.list(query());
      const slot = result.data[0].slots[0] as unknown as Record<
        string,
        unknown
      >;
      expect(slot).not.toHaveProperty('holdsSlot');
      expect(slot).not.toHaveProperty('cancelledById');
      expect(Object.keys(slot).sort()).toEqual([
        'cancelReason',
        'cancelledAt',
        'cancelledByRole',
        'endAt',
        'id',
        'isCancelled',
        'startAt',
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // POST /booking-requests/:id/approve — ADR-001
  // ────────────────────────────────────────────────────────────────────────────────
  describe('approve', () => {
    /** The happy path's collaborators; each test overrides only the one it is about. */
    const pendingBooking = (over: Record<string, unknown> = {}) => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          venueId: VENUE_ID,
          status: BookingStatus.PENDING,
          ...over,
        })
        .mockResolvedValueOnce({ status: BookingStatus.PENDING, ...over });
      bookingSlot.findMany.mockResolvedValue([
        { startAt: at(DAY), endAt: at(DAY + HOUR) },
      ]);
      bookingSlot.findFirst.mockResolvedValue(null);
      bookingRequest.findMany.mockResolvedValue([]);
      bookingRequest.updateMany.mockResolvedValue({ count: 1 });
      // The final detail read, off the transaction.
      bookingRequest.findUnique.mockResolvedValue(detailRow());
    };

    it('takes the advisory lock on the venue BEFORE any deciding read', async () => {
      pendingBooking();
      await service.approve(BOOKING_ID, ACTOR);

      expect($executeRaw).toHaveBeenCalledTimes(1);
      // The lock precedes the slot read, the clash check and the loser read — a lock taken later
      // would be locking after the reads it exists to protect.
      const lockOrder = $executeRaw.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(
        bookingSlot.findMany.mock.invocationCallOrder[0],
      );
      expect(lockOrder).toBeLessThan(
        bookingSlot.findFirst.mock.invocationCallOrder[0],
      );
      expect(lockOrder).toBeLessThan(
        bookingRequest.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('flips the request with a CONDITIONAL updateMany and records who ruled and when', async () => {
      pendingBooking();
      await service.approve(BOOKING_ID, ACTOR);

      const args = callArg<{
        where: { id: string; status: BookingStatus };
        data: {
          status: BookingStatus;
          approvedById: string;
          approvedAt: Date;
        };
      }>(bookingRequest.updateMany);
      // `updateMany` with `status: PENDING` in the WHERE — Postgres arbitrates the state machine,
      // so a double-tap loses on `count === 0` rather than writing twice.
      expect(args.where).toEqual({
        id: BOOKING_ID,
        status: BookingStatus.PENDING,
      });
      expect(args.data.status).toBe(BookingStatus.APPROVED);
      expect(args.data.approvedById).toBe(ACTOR.id);
      expect(args.data.approvedAt).toBeInstanceOf(Date);
    });

    /**
     * 🔴 AC-BR14 — the losers are READ BEFORE THIS REQUEST'S STATUS FLIPS. Read afterwards, this
     * request would no longer be PENDING and the reported set could differ from the written one.
     */
    it('reads the losers BEFORE the flip and rejects them AFTER it', async () => {
      pendingBooking();
      // `…Once`: the SECOND `findMany` on this delegate is the post-commit realtime re-read, which
      // wants queue rows rather than loser rows and is covered by its own tests below.
      bookingRequest.findMany.mockResolvedValueOnce([
        {
          id: LOSER_ID,
          code: 'BR-25690903-002',
          firstStartAt: at(DAY),
          lastEndAt: at(DAY + HOUR),
        },
      ]);
      const result = await service.approve(BOOKING_ID, ACTOR);

      const loserRead = bookingRequest.findMany.mock.invocationCallOrder[0];
      const flip = bookingRequest.updateMany.mock.invocationCallOrder[0];
      const rejectWrite = bookingRequest.updateMany.mock.invocationCallOrder[1];
      expect(loserRead).toBeLessThan(flip);
      expect(flip).toBeLessThan(rejectWrite);

      const rejectArgs = callArg<{
        where: { id: { in: string[] }; status: BookingStatus };
        data: { status: BookingStatus; rejectReason: string };
      }>(bookingRequest.updateMany, 1);
      expect(rejectArgs.where.id).toEqual({ in: [LOSER_ID] });
      // Somebody else's decision in the meantime must not be overwritten.
      expect(rejectArgs.where.status).toBe(BookingStatus.PENDING);
      expect(rejectArgs.data.status).toBe(BookingStatus.REJECTED);
      expect(rejectArgs.data.rejectReason).toBe(AUTO_REJECTED_REASON);

      expect(result.autoRejected).toEqual([
        { id: LOSER_ID, code: 'BR-25690903-002' },
      ]);
    });

    /** 🔴 AC-BR15 — the string the LOSER reads must name nobody. */
    it('auto-rejects with a reason that names no person, department, purpose or code', () => {
      expect(AUTO_REJECTED_REASON).not.toMatch(/BR-\d/);
      expect(AUTO_REJECTED_REASON).not.toMatch(/[A-Za-z]{3,}/);
      expect(AUTO_REJECTED_REASON).not.toMatch(/ชื่อ|ฝ่าย|โดย|คุณ/);
      expect(AUTO_REJECTED_REASON.length).toBeGreaterThan(0);
    });

    it('writes NOTHING when there are no losers', async () => {
      pendingBooking();
      const result = await service.approve(BOOKING_ID, ACTOR);
      expect(bookingRequest.updateMany).toHaveBeenCalledTimes(1);
      expect(result.autoRejected).toEqual([]);
    });

    it('404s an unknown id, without taking a lock', async () => {
      bookingRequest.findUnique.mockResolvedValueOnce(null);
      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        new NotFoundException(BOOKING_NOT_FOUND),
      );
      expect($executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      BookingStatus.APPROVED,
      BookingStatus.REJECTED,
      BookingStatus.CANCELLED,
    ])('409s a request that is %s, writing nothing', async (status) => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({ id: BOOKING_ID, venueId: VENUE_ID, status })
        .mockResolvedValueOnce({ status });
      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION),
      );
      expect(bookingRequest.updateMany).not.toHaveBeenCalled();
    });

    it('409s when every slot is already cancelled', async () => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          venueId: VENUE_ID,
          status: BookingStatus.PENDING,
        })
        .mockResolvedValueOnce({ status: BookingStatus.PENDING });
      bookingSlot.findMany.mockResolvedValue([]);
      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        new ConflictException(BOOKING_ALREADY_CANCELLED),
      );
      expect(bookingRequest.updateMany).not.toHaveBeenCalled();
    });

    /**
     * 🔴 AC-BR17 — the hard block, and NO write of any kind. The clash check precedes the loser
     * read: if the room is gone this approval does not happen, so nobody is rejected for it.
     */
    it('409s SLOT_TAKEN on an APPROVED clash, before reading losers and without writing', async () => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          venueId: VENUE_ID,
          status: BookingStatus.PENDING,
        })
        .mockResolvedValueOnce({ status: BookingStatus.PENDING });
      bookingSlot.findMany.mockResolvedValue([
        { startAt: at(DAY), endAt: at(DAY + HOUR) },
      ]);
      bookingSlot.findFirst.mockResolvedValue({
        id: 'taken',
        bookingRequestId: 'other',
      });

      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        new ConflictException(SLOT_TAKEN),
      );
      expect(bookingRequest.findMany).not.toHaveBeenCalled();
      expect(bookingRequest.updateMany).not.toHaveBeenCalled();
    });

    it('409s when the conditional flip matches nothing — somebody decided first', async () => {
      pendingBooking();
      bookingRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION),
      );
      // The losers are not rejected for an approval that did not happen.
      expect(bookingRequest.updateMany).toHaveBeenCalledTimes(1);
    });

    it('excludes the request itself from both the clash check and the loser set', async () => {
      pendingBooking();
      await service.approve(BOOKING_ID, ACTOR);
      const clash = callArg<{
        where: { bookingRequestId?: { not: string } };
      }>(bookingSlot.findFirst);
      expect(clash.where.bookingRequestId).toEqual({ not: BOOKING_ID });
      const losers = callArg<{ where: { id?: { not: string } } }>(
        bookingRequest.findMany,
      );
      expect(losers.where.id).toEqual({ not: BOOKING_ID });
    });

    // ── AC-BR22: the SQLSTATEs must be 409, never 500 ────────────────────────────
    it('maps 23P01 to 409 SLOT_TAKEN', async () => {
      pendingBooking();
      bookingRequest.updateMany.mockRejectedValue(driverError('23P01'));
      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        new ConflictException(SLOT_TAKEN),
      );
    });

    it.each(['40P01', '40001'])(
      'maps %s to 409 BOOKING_DECISION_RACE',
      async (code) => {
        pendingBooking();
        bookingRequest.updateMany.mockRejectedValue(driverError(code));
        await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
          new ConflictException(BOOKING_DECISION_RACE),
        );
      },
    );

    it('RETHROWS an unrecognised error rather than dressing it as a 409', async () => {
      pendingBooking();
      bookingRequest.updateMany.mockRejectedValue(new Error('disk on fire'));
      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        'disk on fire',
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // POST /booking-requests/:id/reject
  // ────────────────────────────────────────────────────────────────────────────────
  describe('reject', () => {
    it('writes the reason, touches NO slot, and takes NO advisory lock', async () => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          status: BookingStatus.PENDING,
        })
        .mockResolvedValue(detailRow({ status: BookingStatus.REJECTED }));
      bookingRequest.updateMany.mockResolvedValue({ count: 1 });

      await service.reject(BOOKING_ID, { reason: 'ห้องไม่ว่าง' }, ACTOR);

      const args = callArg<{
        data: { status: BookingStatus; rejectReason: string };
      }>(bookingRequest.updateMany);
      expect(args.data).toEqual({
        status: BookingStatus.REJECTED,
        rejectReason: 'ห้องไม่ว่าง',
      });
      // ⛔ A rejected request keeps its slots. `isCancelled` means "this span was cancelled", which
      // is a different fact — and writing it here would leave `cancelledAt` null: a corrupt row.
      expect(bookingSlot.findMany).not.toHaveBeenCalled();
      expect($executeRaw).not.toHaveBeenCalled();
    });

    it('409s an APPROVED request — the way back is cancel, not reject', async () => {
      bookingRequest.findUnique.mockResolvedValueOnce({
        id: BOOKING_ID,
        status: BookingStatus.APPROVED,
      });
      await expect(
        service.reject(BOOKING_ID, { reason: 'x' }, ACTOR),
      ).rejects.toThrow(
        new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION),
      );
      expect(bookingRequest.updateMany).not.toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
      bookingRequest.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.reject(BOOKING_ID, { reason: 'x' }, ACTOR),
      ).rejects.toThrow(new NotFoundException(BOOKING_NOT_FOUND));
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // POST /booking-requests/:id/cancel — AC-BR9, AC-BR10
  // ────────────────────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    const THREE_SLOTS = [
      { id: 's1', startAt: at(DAY), endAt: at(DAY + HOUR), isCancelled: false },
      {
        id: 's2',
        startAt: at(2 * DAY),
        endAt: at(2 * DAY + HOUR),
        isCancelled: false,
      },
      {
        id: 's3',
        startAt: at(3 * DAY),
        endAt: at(3 * DAY + HOUR),
        isCancelled: false,
      },
    ];

    const approvedBooking = (slots = THREE_SLOTS) => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          venueId: VENUE_ID,
          status: BookingStatus.APPROVED,
        })
        .mockResolvedValueOnce({ status: BookingStatus.APPROVED });
      bookingSlot.findMany.mockResolvedValue(slots);
      bookingRequest.update.mockResolvedValue({});
      bookingRequest.findUnique.mockResolvedValue(detailRow());
    };

    beforeEach(() => {
      bookingSlot.updateMany.mockResolvedValue({ count: 3 });
    });

    it('cancels every live slot when `slotIds` is omitted, writing all five columns together', async () => {
      approvedBooking();
      await service.cancel(BOOKING_ID, { reason: 'ซ่อมแอร์' }, ACTOR);

      const args = callArg<{
        where: { id: { in: string[] }; isCancelled: boolean };
        data: Record<string, unknown>;
      }>(bookingSlot.updateMany);
      expect(args.where.id.in.sort()).toEqual(['s1', 's2', 's3']);
      // 🔴 The flag and the timestamp are a PAIR; a row with one and not the other is corrupt.
      expect(args.data).toEqual({
        isCancelled: true,
        // `expect.any` is typed `any`; the cast keeps the type-checked lint rules satisfied.
        cancelledAt: expect.any(Date) as unknown,
        cancelledById: ACTOR.id,
        cancelledByRole: SystemRole.ADMIN,
        cancelReason: 'ซ่อมแอร์',
      });
    });

    it('turns the request CANCELLED when nothing survives — and LEAVES the span alone', async () => {
      approvedBooking();
      await service.cancel(BOOKING_ID, { reason: 'ปิดปรับปรุง' }, ACTOR);
      const args = callArg<{
        data: Record<string, unknown>;
      }>(bookingRequest.update);
      // ⚠️ No `firstStartAt`/`lastEndAt` here: `min()` over zero live slots has no honest answer,
      // and the history group still needs a date to sort by.
      expect(args.data).toEqual({ status: BookingStatus.CANCELLED });
    });

    /** 🔴 AC-BR10 — the denormalised span is recomputed from the SURVIVORS, same transaction. */
    it('recomputes the span from the surviving slots on a partial cancel', async () => {
      approvedBooking();
      bookingSlot.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel(
        BOOKING_ID,
        { reason: 'งดใช้ห้อง', slotIds: ['s1'] },
        ACTOR,
      );

      const args = callArg<{
        data: { firstStartAt: Date; lastEndAt: Date; status?: BookingStatus };
      }>(bookingRequest.update);
      expect(args.data.status).toBeUndefined();
      expect(args.data.firstStartAt.getTime()).toBe(
        THREE_SLOTS[1].startAt.getTime(),
      );
      expect(args.data.lastEndAt.getTime()).toBe(
        THREE_SLOTS[2].endAt.getTime(),
      );
    });

    /** 🔴 AC-BR9 — an id from another booking is REFUSED, never quietly skipped. */
    it('400s a slot id that is not on this booking, writing nothing', async () => {
      approvedBooking();
      await expect(
        service.cancel(
          BOOKING_ID,
          { reason: 'x', slotIds: ['s1', 'somebody-elses-slot'] },
          ACTOR,
        ),
      ).rejects.toThrow(new BadRequestException(SLOT_NOT_ON_THIS_BOOKING));
      expect(bookingSlot.updateMany).not.toHaveBeenCalled();
    });

    it('409s a named slot that is already cancelled', async () => {
      approvedBooking([
        { ...THREE_SLOTS[0], isCancelled: true },
        THREE_SLOTS[1],
        THREE_SLOTS[2],
      ]);
      await expect(
        service.cancel(BOOKING_ID, { reason: 'x', slotIds: ['s1'] }, ACTOR),
      ).rejects.toThrow(new ConflictException(SLOT_ALREADY_CANCELLED));
    });

    it('409s when every slot is already cancelled', async () => {
      approvedBooking(THREE_SLOTS.map((s) => ({ ...s, isCancelled: true })));
      await expect(
        service.cancel(BOOKING_ID, { reason: 'x' }, ACTOR),
      ).rejects.toThrow(new ConflictException(BOOKING_ALREADY_CANCELLED));
    });

    it.each([
      BookingStatus.PENDING,
      BookingStatus.REJECTED,
      BookingStatus.CANCELLED,
    ])('409s a request that is %s', async (status) => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({ id: BOOKING_ID, venueId: VENUE_ID, status })
        .mockResolvedValueOnce({ status });
      await expect(
        service.cancel(BOOKING_ID, { reason: 'x' }, ACTOR),
      ).rejects.toThrow(new ConflictException(BOOKING_NOT_APPROVED_FOR_CANCEL));
    });

    /**
     * 🔴 `Q-C4` ① IS AN END-USER RULE AND MUST NOT REACH THIS PATH. Copying it would make it
     * permanently impossible for staff to cancel anything happening today.
     */
    it('never reads `booking.cancel_lead_minutes` — a slot starting in ten minutes is cancellable', async () => {
      approvedBooking([
        {
          id: 's1',
          startAt: at(10 * 60_000),
          endAt: at(HOUR),
          isCancelled: false,
        },
      ]);
      bookingSlot.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        service.cancel(BOOKING_ID, { reason: 'ท่อน้ำแตก' }, ACTOR),
      ).resolves.toBeDefined();
    });

    it('records the actor’s REAL SystemRole, not a hard-coded string', async () => {
      approvedBooking();
      await service.cancel(
        BOOKING_ID,
        { reason: 'x' },
        { id: 'su', name: 'ผู้ดูแลระบบ', role: SystemRole.SUPER_ADMIN },
      );
      const args = callArg<{
        data: { cancelledByRole: string };
      }>(bookingSlot.updateMany);
      expect(args.data.cancelledByRole).toBe(SystemRole.SUPER_ADMIN);
    });

    it('takes the advisory lock before reading the slots', async () => {
      approvedBooking();
      await service.cancel(BOOKING_ID, { reason: 'x' }, ACTOR);
      expect($executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        bookingSlot.findMany.mock.invocationCallOrder[0],
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // POST /booking-requests/direct — AC-BR11, AC-BR13, AC-BR16
  // ────────────────────────────────────────────────────────────────────────────────
  describe('createDirect', () => {
    const dto = (over: Partial<CreateDirectBookingDto> = {}) =>
      ({
        venueId: VENUE_ID,
        purpose: 'ประชุมคณะกรรมการ',
        attendees: 20,
        slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
        requesterName: 'สพท.',
        contactPhone: '02-000-0000',
        ...over,
      }) as CreateDirectBookingDto;

    const happyPath = () => {
      venue.findFirst.mockResolvedValue({ id: VENUE_ID });
      bookingSlot.findFirst.mockResolvedValue(null);
      bookingRequest.findMany.mockResolvedValue([]);
      bookingRequest.count.mockResolvedValue(0);
      bookingRequest.create.mockResolvedValue({ id: BOOKING_ID });
      bookingRequest.findUnique.mockResolvedValue(detailRow());
    };

    it('creates APPROVED with approvedById === createdById === the caller (AC-BR11)', async () => {
      happyPath();
      await service.createDirect(dto(), ACTOR);
      const { data } = callArg<{
        data: Record<string, unknown>;
      }>(bookingRequest.create);
      expect(data.status).toBe(BookingStatus.APPROVED);
      expect(data.createdById).toBe(ACTOR.id);
      // 🔴 Creation IS the approval (`D-C18`) — same person, two columns that still mean different
      // things: who typed it, and who allowed it.
      expect(data.approvedById).toBe(ACTOR.id);
      expect(data.approvedAt).toBeInstanceOf(Date);
      expect(data.code).toBe('BR-' + String(data.code).split('-')[1] + '-001');
    });

    it('copies `venueId` onto every slot and computes the span in the same statement', async () => {
      happyPath();
      await service.createDirect(
        dto({
          slots: [
            { startAt: iso(3 * DAY), endAt: iso(3 * DAY + HOUR) },
            { startAt: iso(DAY), endAt: iso(DAY + HOUR) },
          ],
        }),
        ACTOR,
      );
      const { data } = callArg<{
        data: {
          firstStartAt: Date;
          lastEndAt: Date;
          slots: { create: { venueId: string }[] };
        };
      }>(bookingRequest.create);
      expect(data.slots.create.every((s) => s.venueId === VENUE_ID)).toBe(true);
      // min/max over the WHOLE set, not `slots[0]` — the input was deliberately unordered.
      expect(data.firstStartAt.getTime()).toBeLessThan(
        data.lastEndAt.getTime() - HOUR,
      );
    });

    it('auto-rejects overlapping PENDING requests here too (AC-BR16)', async () => {
      happyPath();
      // `…Once` for the same reason as on the approve path: the next `findMany` is the realtime
      // re-read, not a second loser query.
      bookingRequest.findMany.mockResolvedValueOnce([
        {
          id: LOSER_ID,
          code: 'BR-25690903-009',
          firstStartAt: at(DAY),
          lastEndAt: at(DAY + HOUR),
        },
      ]);
      bookingRequest.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.createDirect(dto(), ACTOR);

      expect(result.autoRejected).toEqual([
        { id: LOSER_ID, code: 'BR-25690903-009' },
      ]);
      const args = callArg<{
        data: { rejectReason: string };
      }>(bookingRequest.updateMany);
      expect(args.data.rejectReason).toBe(AUTO_REJECTED_REASON);
      // Read before the INSERT, for the same reason as on the approve path.
      expect(bookingRequest.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        bookingRequest.create.mock.invocationCallOrder[0],
      );
    });

    it('409s SLOT_TAKEN on an APPROVED clash without creating anything', async () => {
      happyPath();
      bookingSlot.findFirst.mockResolvedValue({
        id: 'taken',
        bookingRequestId: 'other',
      });
      await expect(service.createDirect(dto(), ACTOR)).rejects.toThrow(
        new ConflictException(SLOT_TAKEN),
      );
      expect(bookingRequest.create).not.toHaveBeenCalled();
    });

    it('404s an unknown or soft-deleted venue', async () => {
      happyPath();
      venue.findFirst.mockResolvedValue(null);
      await expect(service.createDirect(dto(), ACTOR)).rejects.toThrow(
        new NotFoundException(VENUE_NOT_FOUND),
      );
    });

    /**
     * 🟡 G2 — a CLOSED venue accepts a direct booking. `isOpen` refuses new REQUESTS, and a staff
     * lock is not a request; a room closed for repairs is exactly one staff must be able to block.
     */
    it('does NOT filter on `isOpen` — a closed venue may still be locked by staff', async () => {
      happyPath();
      await service.createDirect(dto(), ACTOR);
      const args = callArg<{
        where: Record<string, unknown>;
      }>(venue.findFirst);
      expect(args.where).toEqual({ id: VENUE_ID, deletedAt: null });
      expect(args.where.isOpen).toBeUndefined();
    });

    // ── The A/B origin rule ──────────────────────────────────────────────────────
    it('400s when `lineUserId` arrives together with any override', async () => {
      happyPath();
      for (const over of [
        { lineUserId: 'lu', requesterName: 'x' },
        { lineUserId: 'lu', contactPhone: '02' },
        { lineUserId: 'lu', departmentId: 1 },
      ]) {
        await expect(
          service.createDirect(
            dto({
              requesterName: undefined,
              contactPhone: undefined,
              ...over,
            }),
            ACTOR,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(bookingRequest.create).not.toHaveBeenCalled();
    });

    it('accepts path (A) alone and writes the three overrides as null', async () => {
      happyPath();
      lineUser.findFirst.mockResolvedValue({ id: 'lu' });
      await service.createDirect(
        dto({
          lineUserId: 'lu',
          requesterName: undefined,
          contactPhone: undefined,
        }),
        ACTOR,
      );
      const { data } = callArg<{
        data: Record<string, unknown>;
      }>(bookingRequest.create);
      expect(data.lineUserId).toBe('lu');
      // 🔴 Overrides, not a second profile store: with a LINE user attached they MUST be null, or
      // the name on the row is free to disagree with the registration.
      expect(data.requesterName).toBeNull();
      expect(data.contactPhone).toBeNull();
      expect(data.departmentId).toBeNull();
    });

    it.each([
      ['unknown', null],
      ['not ALLOWED', null],
    ])(
      '400s a %s lineUserId, checked inside the transaction',
      async (_l, row) => {
        happyPath();
        lineUser.findFirst.mockResolvedValue(row);
        await expect(
          service.createDirect(
            dto({
              lineUserId: 'lu',
              requesterName: undefined,
              contactPhone: undefined,
            }),
            ACTOR,
          ),
        ).rejects.toThrow(new BadRequestException(INVALID_LINE_USER));
        const args = callArg<{
          where: Record<string, unknown>;
        }>(lineUser.findFirst);
        expect(args.where).toEqual({
          id: 'lu',
          deletedAt: null,
          access: AppAccess.ALLOWED,
        });
      },
    );

    /** AC-BR13 — the FK cannot do this: `Restrict` guards hard deletes, and soft-deleted rows exist. */
    it('400s a soft-deleted department, filtered on `deletedAt: null` in the transaction', async () => {
      happyPath();
      department.findFirst.mockResolvedValue(null);
      await expect(
        service.createDirect(dto({ departmentId: 7 }), ACTOR),
      ).rejects.toThrow(new BadRequestException(INVALID_DEPARTMENT));
      const args = callArg<{
        where: Record<string, unknown>;
      }>(department.findFirst);
      expect(args.where).toEqual({ id: 7, deletedAt: null });
    });

    it('rejects a past slot at the 400 boundary before opening a transaction', async () => {
      happyPath();
      await expect(
        service.createDirect(
          dto({ slots: [{ startAt: iso(-HOUR), endAt: iso(HOUR) }] }),
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect($transaction).not.toHaveBeenCalled();
    });

    it('maps 23P01 raised by the nested slot insert to 409 SLOT_TAKEN', async () => {
      happyPath();
      bookingRequest.create.mockRejectedValue(driverError('23P01'));
      await expect(service.createDirect(dto(), ACTOR)).rejects.toThrow(
        new ConflictException(SLOT_TAKEN),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // POST /booking-requests/preflight — G1
  // ────────────────────────────────────────────────────────────────────────────────
  describe('checkPreflight', () => {
    const dto = (
      over: Partial<BookingPreflightDto> = {},
    ): BookingPreflightDto => ({
      venueId: VENUE_ID,
      slots: [{ startAt: iso(DAY), endAt: iso(DAY + 2 * HOUR) }],
      ...over,
    });

    const openVenue = () => {
      venue.findFirst.mockResolvedValue({ id: VENUE_ID, isOpen: true });
      bookingSlot.count.mockResolvedValue(0);
      bookingRequest.findMany.mockResolvedValue([]);
    };

    it('answers a clean set with no clash and an empty list', async () => {
      openVenue();
      await expect(service.checkPreflight(dto())).resolves.toEqual({
        hasApprovedClash: false,
        approvedClashCount: 0,
        overlappingPendingRequests: [],
        venueIsOpen: true,
      });
    });

    /**
     * ⚠️ THE UNIT IS SLOTS, NOT BOOKINGS. One approved three-day booking overlapping three requested
     * days counts 3 — the count comes from `bookingSlot.count`, and the DTO says so, because a screen
     * printing "3 conflicting bookings" for one booking would be lying.
     */
    it('reports the APPROVED clash as a SLOT count over the shared predicate', async () => {
      openVenue();
      bookingSlot.count.mockResolvedValue(3);
      const res = await service.checkPreflight(dto());
      expect(res.hasApprovedClash).toBe(true);
      expect(res.approvedClashCount).toBe(3);

      // 🔴 The very `where` `booking-overlap.ts` owns — the parent's status, NEVER `holdsSlot`.
      const args = callArg<{ where: Record<string, unknown> }>(
        bookingSlot.count,
      );
      expect(args.where).toMatchObject({
        venueId: VENUE_ID,
        isCancelled: false,
        bookingRequest: { status: BookingStatus.APPROVED },
      });
      // Nothing is excluded: these spans belong to no request yet.
      expect(args.where.bookingRequestId).toBeUndefined();
    });

    /**
     * 🔴 ONE ENTRY PER REQUEST HOWEVER MANY OF ITS SLOTS OVERLAP. `findPendingLosers` queries
     * `bookingRequest` with `slots: { some: … }`, so the deduplication is structural rather than a
     * `Set` somebody has to remember to keep.
     */
    it('lists each overlapping PENDING request ONCE, with its code, purpose and requester', async () => {
      openVenue();
      bookingRequest.findMany
        // The loser read.
        .mockResolvedValueOnce([
          {
            id: LOSER_ID,
            code: 'BR-25690903-002',
            firstStartAt: at(DAY),
            lastEndAt: at(DAY + HOUR),
          },
        ])
        // The single detail read that resolves every loser at once — never one query per loser.
        .mockResolvedValueOnce([
          {
            id: LOSER_ID,
            purpose: 'อบรมครู',
            requesterName: null,
            contactPhone: null,
            department: null,
            lineUser: {
              registration: {
                firstName: 'สมชาย',
                lastName: 'ใจดี',
                phone: '081',
                department: null,
              },
            },
          },
        ]);

      const res = await service.checkPreflight(dto());
      expect(res.overlappingPendingRequests).toEqual([
        {
          id: LOSER_ID,
          code: 'BR-25690903-002',
          purpose: 'อบรมครู',
          requesterName: 'สมชาย ใจดี',
        },
      ]);
      // Two reads for N losers, not N + 1.
      expect(bookingRequest.findMany).toHaveBeenCalledTimes(2);
    });

    it('reports `venueIsOpen: false` WITHOUT refusing — a staff lock is not a request', async () => {
      openVenue();
      venue.findFirst.mockResolvedValue({ id: VENUE_ID, isOpen: false });
      const res = await service.checkPreflight(dto());
      expect(res.venueIsOpen).toBe(false);
      expect(res.hasApprovedClash).toBe(false);
    });

    it('404s an unknown or soft-deleted venue, filtered on `deletedAt: null`', async () => {
      venue.findFirst.mockResolvedValue(null);
      await expect(service.checkPreflight(dto())).rejects.toThrow(
        new NotFoundException(VENUE_NOT_FOUND),
      );
      const args = callArg<{ where: Record<string, unknown> }>(venue.findFirst);
      expect(args.where).toEqual({ id: VENUE_ID, deletedAt: null });
    });

    /**
     * 🔴 THE SAME `parseSlots` `direct` USES, AND BEFORE THE VENUE READ. A preflight that accepts a
     * span the submit then refuses with a 400 has lied to the operator — so the 400/404 precedence
     * must match `createDirect`'s too.
     */
    it.each([
      ['past', [{ startAt: iso(-HOUR), endAt: iso(HOUR) }]],
      ['inverted', [{ startAt: iso(DAY + HOUR), endAt: iso(DAY) }]],
      [
        'self-overlapping',
        [
          { startAt: iso(DAY), endAt: iso(DAY + 3 * HOUR) },
          { startAt: iso(DAY + 2 * HOUR), endAt: iso(DAY + 4 * HOUR) },
        ],
      ],
    ])(
      '400s a %s span before it ever reads the venue',
      async (_label, slots) => {
        openVenue();
        await expect(
          service.checkPreflight(dto({ slots })),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(venue.findFirst).not.toHaveBeenCalled();
      },
    );

    /**
     * 🔴 NO LOCK, NO TRANSACTION, NO WRITE. This runs while an operator is typing; taking the venue's
     * advisory lock here would let a fast typist block every approval on that venue.
     */
    it('takes no advisory lock, opens no transaction and writes nothing', async () => {
      openVenue();
      await service.checkPreflight(dto());
      expect($executeRaw).not.toHaveBeenCalled();
      expect($transaction).not.toHaveBeenCalled();
      expect(bookingRequest.create).not.toHaveBeenCalled();
      expect(bookingRequest.update).not.toHaveBeenCalled();
      expect(bookingRequest.updateMany).not.toHaveBeenCalled();
      expect(bookingSlot.updateMany).not.toHaveBeenCalled();
    });
  });

  /**
   * 🔴 THE POINT OF THE SHARED CORE: the create dialog and the detail dialog must never disagree
   * about the same venue and the same hour. These two assert that `conflictsOf` and `checkPreflight`
   * read the SAME predicate rather than two copies of it.
   */
  describe('conflicts and preflight share one core', () => {
    const spans = [{ startAt: iso(DAY), endAt: iso(DAY + 2 * HOUR) }];

    it('both build the APPROVED clash `where` from `approvedClashWhere`', async () => {
      venue.findFirst.mockResolvedValue({ id: VENUE_ID, isOpen: true });
      bookingSlot.count.mockResolvedValue(1);
      bookingRequest.findMany.mockResolvedValue([]);
      await service.checkPreflight({
        venueId: VENUE_ID,
        slots: spans,
      });

      // The saved-request side, through `getDetail` → `conflictsOf`.
      bookingRequest.findUnique.mockResolvedValue(
        detailRow({
          status: BookingStatus.PENDING,
          slots: [
            {
              id: 'slot-1',
              startAt: new Date(spans[0].startAt),
              endAt: new Date(spans[0].endAt),
              isCancelled: false,
              cancelledAt: null,
              cancelReason: null,
              cancelledByRole: null,
            },
          ],
        }),
      );
      const detail = await service.getDetail(BOOKING_ID);

      const fromPreflight = callArg<{ where: Record<string, unknown> }>(
        bookingSlot.count,
        0,
      ).where;
      const fromDetail = callArg<{ where: Record<string, unknown> }>(
        bookingSlot.count,
        1,
      ).where;
      // Identical but for the self-exclusion a saved request needs and unsaved spans cannot have.
      expect(fromDetail).toEqual({
        ...fromPreflight,
        bookingRequestId: { not: BOOKING_ID },
      });
      expect(detail.conflicts.approvedClash).toBe(true);
    });

    it('answers the empty question without a query on a settled request', async () => {
      bookingRequest.findUnique.mockResolvedValue(
        detailRow({ status: BookingStatus.REJECTED }),
      );
      const detail = await service.getDetail(BOOKING_ID);
      expect(detail.conflicts).toEqual({
        approvedClash: false,
        pendingLosers: [],
      });
      // `conflictsOf` keeps its own early-outs; the shared core is never reached.
      expect(bookingSlot.count).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // ADMIN-REALTIME-BOOKINGS-1 — the `/admin` fan-out (design constraint `Q4`)
  // ────────────────────────────────────────────────────────────────────────────────
  describe('realtime fan-out', () => {
    const LOSER_2_ID = 'clx_loser2_cuid';

    /** Exactly `AdminBookingRequestListItemDto`'s keys — the payload contract, in one list. */
    const LIST_ITEM_KEYS = [
      'attendees',
      'code',
      'createdAt',
      'firstStartAt',
      'id',
      'isExpired',
      'lastEndAt',
      'origin',
      'purpose',
      'rejectReason',
      'requester',
      'slots',
      'status',
      'venue',
    ].sort();

    /** `[booking, actor]` of the Nth emit, typed — a bare `jest.fn()` call tuple is `any`. */
    const emitted = (fn: jest.Mock, call = 0) =>
      (
        fn.mock.calls as unknown as [
          Record<string, unknown> & { id: string },
          Record<string, unknown> | null,
        ][]
      )[call];

    const loser = (id: string, code: string) => ({
      id,
      code,
      firstStartAt: at(DAY),
      lastEndAt: at(DAY + HOUR),
    });

    /** An approval that bumps TWO overlapping pending requests. */
    const approveBumpingTwo = () => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          venueId: VENUE_ID,
          status: BookingStatus.PENDING,
        })
        .mockResolvedValueOnce({ status: BookingStatus.PENDING });
      bookingSlot.findMany.mockResolvedValue([
        { startAt: at(DAY), endAt: at(DAY + HOUR) },
      ]);
      bookingSlot.findFirst.mockResolvedValue(null);
      bookingRequest.findMany
        // 1. the loser read, inside the transaction
        .mockResolvedValueOnce([
          loser(LOSER_ID, 'BR-25690903-002'),
          loser(LOSER_2_ID, 'BR-25690903-003'),
        ])
        // 2. the post-commit re-read. Returned SHUFFLED on purpose: the emit order is the caller's
        //    (subject first, then the losers it displaced), never whatever Postgres hands back.
        .mockResolvedValueOnce([
          detailRow({ id: LOSER_2_ID, status: BookingStatus.REJECTED }),
          detailRow({ id: BOOKING_ID }),
          detailRow({ id: LOSER_ID, status: BookingStatus.REJECTED }),
        ]);
      bookingRequest.updateMany.mockResolvedValue({ count: 1 });
      bookingRequest.findUnique.mockResolvedValue(detailRow());
    };

    /**
     * 🔴 THE DEFECT THIS TICKET EXISTS TO FIX. An approval changes the subject AND every request
     * ADR-001 auto-rejects — rows that belong to other people and are open on other people's
     * screens. Emitting only the subject leaves them stale.
     */
    it('emits ONE `updated` per changed row — the subject AND every auto-rejected loser', async () => {
      approveBumpingTwo();

      const result = await service.approve(BOOKING_ID, ACTOR);

      expect(result.autoRejected).toHaveLength(2);
      expect(realtime.emitBookingRequestUpdated).toHaveBeenCalledTimes(3);
      expect(realtime.emitBookingRequestCreated).not.toHaveBeenCalled();
      expect(
        [0, 1, 2].map(
          (n) => emitted(realtime.emitBookingRequestUpdated, n)[0].id,
        ),
      ).toEqual([BOOKING_ID, LOSER_ID, LOSER_2_ID]);
    });

    it('emits AFTER the transaction commits, never inside it', async () => {
      approveBumpingTwo();

      await service.approve(BOOKING_ID, ACTOR);

      // The loser rejection is the last write of the transaction; every emit follows it, and follows
      // the post-commit re-read that feeds it.
      const lastWrite = bookingRequest.updateMany.mock.invocationCallOrder[1];
      const reread = bookingRequest.findMany.mock.invocationCallOrder[1];
      for (const order of realtime.emitBookingRequestUpdated.mock
        .invocationCallOrder) {
        expect(order).toBeGreaterThan(lastWrite);
        expect(order).toBeGreaterThan(reread);
      }
    });

    /** ONE query for the whole batch — an approval that bumps five losers is still one re-read. */
    it('re-reads every announced row in ONE query, in the queue-row shape', async () => {
      approveBumpingTwo();

      await service.approve(BOOKING_ID, ACTOR);

      const read = callArg<{ where: { id: { in: string[] } } }>(
        bookingRequest.findMany,
        1,
      );
      expect(read.where.id.in).toEqual([BOOKING_ID, LOSER_ID, LOSER_2_ID]);
      // 🔴 The payload is the LIST item, not the richer detail DTO the response carries: the
      // generated client is typed from this shape, and an extra field would be contract drift.
      const [booking] = emitted(realtime.emitBookingRequestUpdated);
      expect(Object.keys(booking).sort()).toEqual(LIST_ITEM_KEYS);
    });

    /** The actor answers "who just did that?" — and carries nothing more, `role` included. */
    it('puts id + name on the wire and NOT the operator’s role', async () => {
      approveBumpingTwo();

      await service.approve(BOOKING_ID, ACTOR);

      for (const call of [0, 1, 2]) {
        const [, actor] = emitted(realtime.emitBookingRequestUpdated, call);
        expect(actor).toEqual({ id: ACTOR.id, name: ACTOR.name });
        expect(actor).not.toHaveProperty('role');
      }
    });

    it('announces NOTHING when the decision was refused', async () => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          venueId: VENUE_ID,
          status: BookingStatus.APPROVED,
        })
        .mockResolvedValueOnce({ status: BookingStatus.APPROVED });

      await expect(service.approve(BOOKING_ID, ACTOR)).rejects.toThrow(
        new ConflictException(BOOKING_NOT_PENDING_FOR_DECISION),
      );
      expect(realtime.emitBookingRequestUpdated).not.toHaveBeenCalled();
      expect(realtime.emitBookingRequestCreated).not.toHaveBeenCalled();
    });

    /** Fail-soft: the write is already durable, so a dead transport must not surface as a 500. */
    it('never fails the request when the transport throws', async () => {
      approveBumpingTwo();
      realtime.emitBookingRequestUpdated.mockImplementationOnce(() => {
        throw new Error('transport down');
      });

      await expect(service.approve(BOOKING_ID, ACTOR)).resolves.toBeDefined();
    });

    it('reject emits one `updated` for the request it refused', async () => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          status: BookingStatus.PENDING,
        })
        .mockResolvedValue(detailRow({ status: BookingStatus.REJECTED }));
      bookingRequest.updateMany.mockResolvedValue({ count: 1 });
      bookingRequest.findMany.mockResolvedValueOnce([
        detailRow({ status: BookingStatus.REJECTED }),
      ]);

      await service.reject(BOOKING_ID, { reason: 'ห้องไม่ว่าง' }, ACTOR);

      expect(realtime.emitBookingRequestUpdated).toHaveBeenCalledTimes(1);
      expect(emitted(realtime.emitBookingRequestUpdated)[0].id).toBe(
        BOOKING_ID,
      );
    });

    it('cancel emits one `updated` — the freed room has to reach every other queue', async () => {
      bookingRequest.findUnique
        .mockResolvedValueOnce({
          id: BOOKING_ID,
          venueId: VENUE_ID,
          status: BookingStatus.APPROVED,
        })
        .mockResolvedValueOnce({ status: BookingStatus.APPROVED });
      bookingSlot.findMany.mockResolvedValue([
        {
          id: 's1',
          startAt: at(DAY),
          endAt: at(DAY + HOUR),
          isCancelled: false,
        },
      ]);
      bookingSlot.updateMany.mockResolvedValue({ count: 1 });
      bookingRequest.update.mockResolvedValue({});
      bookingRequest.findUnique.mockResolvedValue(
        detailRow({ status: BookingStatus.CANCELLED }),
      );
      bookingRequest.findMany.mockResolvedValueOnce([
        detailRow({ status: BookingStatus.CANCELLED }),
      ]);

      await service.cancel(BOOKING_ID, { reason: 'ท่อน้ำแตก' }, ACTOR);

      expect(realtime.emitBookingRequestUpdated).toHaveBeenCalledTimes(1);
      expect(emitted(realtime.emitBookingRequestUpdated)[0].id).toBe(
        BOOKING_ID,
      );
    });

    /**
     * A direct booking is BOTH kinds at once: a row that did not exist (`created`) and every request
     * it took the room from (`updated`). Collapsing them would make the queue either miss the new
     * row or re-insert a loser it already has.
     */
    it('direct emits `created` for the new booking and `updated` for every loser', async () => {
      venue.findFirst.mockResolvedValue({ id: VENUE_ID });
      bookingSlot.findFirst.mockResolvedValue(null);
      bookingRequest.count.mockResolvedValue(0);
      bookingRequest.create.mockResolvedValue({ id: BOOKING_ID });
      bookingRequest.updateMany.mockResolvedValue({ count: 1 });
      bookingRequest.findUnique.mockResolvedValue(detailRow());
      bookingRequest.findMany
        .mockResolvedValueOnce([loser(LOSER_ID, 'BR-25690903-009')])
        .mockResolvedValueOnce([detailRow({ id: BOOKING_ID })])
        .mockResolvedValueOnce([
          detailRow({ id: LOSER_ID, status: BookingStatus.REJECTED }),
        ]);

      await service.createDirect(
        {
          venueId: VENUE_ID,
          purpose: 'ประชุมคณะกรรมการ',
          attendees: 20,
          slots: [{ startAt: iso(DAY), endAt: iso(DAY + HOUR) }],
          requesterName: 'สพท.',
          contactPhone: '02-000-0000',
        },
        ACTOR,
      );

      expect(realtime.emitBookingRequestCreated).toHaveBeenCalledTimes(1);
      expect(emitted(realtime.emitBookingRequestCreated)[0].id).toBe(
        BOOKING_ID,
      );
      expect(realtime.emitBookingRequestUpdated).toHaveBeenCalledTimes(1);
      expect(emitted(realtime.emitBookingRequestUpdated)[0].id).toBe(LOSER_ID);
    });
  });
});
