import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  disabledTriggers,
  rejectingTriggers,
} from '../notifications/triggers/triggers.test-kit';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { R2StorageService } from '../storage/r2-storage.service';
import { VENUE_ALREADY_IN_STATE, VENUE_NOT_FOUND } from './venues.constants';
import { VenuesService } from './venues.service';

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'clx_venue_cuid',
  name: 'ห้องประชุมใหญ่',
  capacity: 40,
  location: null,
  description: null,
  isOpen: false,
  closedReason: 'ปิดปรับปรุง',
  createdAt: new Date(),
  updatedAt: new Date(),
  venueType: { id: 1, name: 'ห้องประชุม', isSystemReserved: false },
  photos: [],
  amenities: [],
  ...over,
});

/**
 * `NOTIF-EVENTS-1` C3 — `close()`'s trigger call. Kept minimal: `VenuesService` otherwise has no
 * unit spec (its behaviour is covered end-to-end by `test/venues.e2e-spec.ts`).
 */
describe('VenuesService — close (C3)', () => {
  const venue = { findFirst: jest.fn(), update: jest.fn() };
  const redis = { del: jest.fn() };
  const prisma = { venue } as unknown as PrismaService;
  const storage = {} as unknown as R2StorageService;
  const ACTOR = { id: 'op-1', name: 'วีระ ทองดี' };
  const service = (triggers: ReturnType<typeof disabledTriggers>) =>
    new VenuesService(
      prisma,
      redis as unknown as RedisService,
      storage,
      triggers,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    venue.findFirst.mockResolvedValue({ id: 'clx_venue_cuid', isOpen: true });
    venue.update.mockResolvedValue(ROW());
  });

  it('closes an open venue and fires the trigger after the cache drop', async () => {
    const result = await service(disabledTriggers()).close(
      'clx_venue_cuid',
      'ปิดปรับปรุง',
      ACTOR,
    );
    expect(result.isOpen).toBe(false);
    expect(redis.del).toHaveBeenCalled();
  });

  it('404s an unknown/soft-deleted id', async () => {
    venue.findFirst.mockResolvedValue(null);
    await expect(
      service(disabledTriggers()).close('clx_missing', 'x', ACTOR),
    ).rejects.toThrow(new NotFoundException(VENUE_NOT_FOUND));
  });

  it('409s an already-closed venue, writing nothing', async () => {
    venue.findFirst.mockResolvedValue({ id: 'clx_venue_cuid', isOpen: false });
    await expect(
      service(disabledTriggers()).close('clx_venue_cuid', 'x', ACTOR),
    ).rejects.toThrow(new ConflictException(VENUE_ALREADY_IN_STATE));
    expect(venue.update).not.toHaveBeenCalled();
  });

  it('C3 AC-2 — still resolves and the write still committed when the trigger rejects', async () => {
    const { triggers, create, warn } = rejectingTriggers(prisma);

    const result = await service(triggers).close(
      'clx_venue_cuid',
      'ปิดปรับปรุง',
      ACTOR,
    );

    expect(result.isOpen).toBe(false);
    expect(venue.update).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
