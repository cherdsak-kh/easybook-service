import { BookingStatus, SystemRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { Actor } from '../system-users/system-users.policy';
import { AUTO_REJECTED_REASON } from '../bookings/bookings.constants';
import { ReportsService } from './reports.service';

const ACTOR: Actor = { id: 'u1', role: SystemRole.ADMIN, createdById: null };

/** A `firstStartAt` that lands on 2026-01-05 (Monday, Bangkok), well in the past relative to "now". */
const ON_2026_01_05 = new Date('2026-01-05T02:00:00.000Z'); // 09:00 Bangkok

function buildPrisma(overrides: {
  requestRows?: unknown[];
  slotRows?: unknown[];
  venueCount?: number;
  pendingBacklog?: number;
}): PrismaService {
  const {
    requestRows = [],
    slotRows = [],
    venueCount = 5,
    pendingBacklog = 0,
  } = overrides;
  return {
    venue: {
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(venueCount),
      findMany: jest.fn().mockResolvedValue([]),
    },
    department: { findUnique: jest.fn() },
    bookingRequest: {
      count: jest.fn().mockResolvedValue(pendingBacklog),
      aggregate: jest.fn().mockResolvedValue({ _min: { firstStartAt: null } }),
      findMany: jest.fn().mockResolvedValue(requestRows),
    },
    bookingSlot: { findMany: jest.fn().mockResolvedValue(slotRows) },
    appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
}

/** One `R1_SELECT`-shaped row. `slots` defaults to none (no late-cancellation contribution). */
const row = (status: BookingStatus, rejectReason: string | null = null) => ({
  status,
  rejectReason,
  approvedAt: null,
  firstStartAt: ON_2026_01_05,
  slots: [] as { startAt: Date; cancelledAt: Date | null }[],
});

describe('ReportsService.getOverview — OQ-2 (PO ruling)', () => {
  it('approvedPercent + rejectedPercent + cancelledPercent + expiredPercent + pendingPercent sum to exactly 100', async () => {
    // 10 requests, all attributed to 2026-01-05: 5 approved, 2 rejected (1 auto), 1 cancelled,
    // 1 expired, 1 pending — round numbers so the assertion is exact, not merely close.
    const requestRows = [
      ...Array.from({ length: 5 }, () => row(BookingStatus.APPROVED)),
      row(BookingStatus.REJECTED, AUTO_REJECTED_REASON),
      row(BookingStatus.REJECTED, 'ไม่เหมาะสมกับสถานที่'),
      row(BookingStatus.CANCELLED),
      row(BookingStatus.EXPIRED),
      row(BookingStatus.PENDING),
    ];
    const prisma = buildPrisma({ requestRows });
    const service = new ReportsService(prisma);

    const result = await service.getOverview(
      { startDate: '2026-01-05', endDate: '2026-01-05' },
      ACTOR,
    );

    const { requests } = result;
    expect(requests.total).toBe(10);
    expect(requests.approved).toBe(5);
    expect(requests.rejected).toBe(2);
    expect(requests.autoRejected).toBe(1);
    expect(requests.cancelled).toBe(1);
    expect(requests.expired).toBe(1);
    expect(requests.pending).toBe(1);

    expect(requests.approvedPercent).toBeCloseTo(50, 10);
    expect(requests.rejectedPercent).toBeCloseTo(20, 10);
    expect(requests.cancelledPercent).toBeCloseTo(10, 10);
    expect(requests.expiredPercent).toBeCloseTo(10, 10);
    expect(requests.pendingPercent).toBeCloseTo(10, 10);

    const sum =
      requests.approvedPercent +
      requests.rejectedPercent +
      requests.cancelledPercent +
      requests.expiredPercent +
      requests.pendingPercent;
    expect(sum).toBeCloseTo(100, 10);
  });

  it('sums to 100 for an uneven split too (proves the identity, not just round numbers)', async () => {
    // 7 requests: 3 approved, 1 rejected, 1 cancelled, 1 expired, 1 pending.
    const requestRows = [
      ...Array.from({ length: 3 }, () => row(BookingStatus.APPROVED)),
      row(BookingStatus.REJECTED),
      row(BookingStatus.CANCELLED),
      row(BookingStatus.EXPIRED),
      row(BookingStatus.PENDING),
    ];
    const prisma = buildPrisma({ requestRows });
    const service = new ReportsService(prisma);

    const { requests } = await service.getOverview(
      { startDate: '2026-01-05', endDate: '2026-01-05' },
      ACTOR,
    );

    const sum =
      requests.approvedPercent +
      requests.rejectedPercent +
      requests.cancelledPercent +
      requests.expiredPercent +
      requests.pendingPercent;
    expect(sum).toBeCloseTo(100, 8);
  });

  it('an empty result (total = 0) reports every percent as 0, never NaN', async () => {
    const prisma = buildPrisma({ requestRows: [] });
    const service = new ReportsService(prisma);

    const { requests } = await service.getOverview(
      { startDate: '2026-01-05', endDate: '2026-01-05' },
      ACTOR,
    );

    expect(requests.total).toBe(0);
    for (const value of [
      requests.approvedPercent,
      requests.rejectedPercent,
      requests.cancelledPercent,
      requests.expiredPercent,
      requests.pendingPercent,
    ]) {
      expect(value).toBe(0);
      expect(Number.isNaN(value)).toBe(false);
    }
  });
});
