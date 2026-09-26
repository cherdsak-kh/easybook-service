import { Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { OPTION_NOT_FOUND } from '../options/options.errors';
import { PrismaService } from '../prisma/prisma.service';
import { VENUE_TYPE_CACHE_KEYS } from '../redis/cache-keys';
import { RedisService } from '../redis/redis.service';
import { TOMBSTONE_VENUE_TYPE_NAME } from './venue-types.constants';
import { VenueTypesService } from './venue-types.service';

const TARGET_ID = 7;
const EXISTING_TOMBSTONE_ID = 4;
const CREATED_TOMBSTONE_ID = 42;

/** The probe shape the service must use: name + ACTIVE + RESERVED. */
const TOMBSTONE_PROBE = {
  where: {
    name: TOMBSTONE_VENUE_TYPE_NAME,
    deletedAt: null,
    isSystemReserved: true,
  },
  select: { id: true },
};

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: ['name'] },
  });

interface FindFirstArgs {
  where: { id?: number; name?: string };
}

describe('VenueTypesService', () => {
  let service: VenueTypesService;
  let venueType: {
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let venue: { updateMany: jest.Mock };
  let $transaction: jest.Mock;
  let redisDel: jest.Mock;
  let logSpy: jest.SpyInstance;

  /**
   * `findFirst` serves two different questions in `softDelete`: "does the target exist" (keyed by
   * `id`) and "where is the tombstone" (keyed by `name`). The target always exists here; each
   * tombstone probe takes the next answer off `probeAnswers`, so a test states exactly what the
   * first and the re-probe see.
   */
  const tombstoneProbesReturn = (...probeAnswers: Array<number | null>) => {
    venueType.findFirst.mockImplementation((args: FindFirstArgs) => {
      if (args.where.id !== undefined) {
        return Promise.resolve({ id: args.where.id });
      }
      const next = probeAnswers.shift();
      return Promise.resolve(next == null ? null : { id: next });
    });
  };

  const tombstoneProbeCalls = (): FindFirstArgs[] =>
    (venueType.findFirst.mock.calls as Array<[FindFirstArgs]>)
      .map(([args]) => args)
      .filter((args) => args.where.name !== undefined);

  const autoCreateLogs = (): string[] =>
    (logSpy.mock.calls as unknown[][])
      .map(([message]) => message)
      .filter(
        (message): message is string =>
          typeof message === 'string' && message.includes('auto-created'),
      );

  beforeEach(async () => {
    venueType = { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() };
    venue = { updateMany: jest.fn().mockResolvedValue({ count: 3 }) };
    // The interactive form: run the callback against the same mocks, so the assertions below see
    // the statements the transaction would actually issue.
    $transaction = jest.fn((cb: (tx: unknown) => unknown) =>
      cb({ venueType, venue }),
    );
    redisDel = jest.fn();
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VenueTypesService,
        {
          provide: PrismaService,
          useValue: { venueType, venue, $transaction },
        },
        {
          provide: RedisService,
          useValue: {
            getJson: jest.fn().mockResolvedValue(null),
            setJson: jest.fn(),
            del: redisDel,
          },
        },
      ],
    }).compile();
    service = module.get<VenueTypesService>(VenueTypesService);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('softDelete — tombstone resolution', () => {
    it('AC-5 · tombstone present: reuses it, never creates, never logs an auto-create', async () => {
      tombstoneProbesReturn(EXISTING_TOMBSTONE_ID);

      await service.softDelete(TARGET_ID);

      expect(venueType.findFirst).toHaveBeenCalledWith(TOMBSTONE_PROBE);
      expect(venueType.create).not.toHaveBeenCalled();
      expect(venue.updateMany).toHaveBeenCalledWith({
        where: { venueTypeId: TARGET_ID },
        data: { venueTypeId: EXISTING_TOMBSTONE_ID },
      });
      expect(venueType.update).toHaveBeenCalledWith({
        where: { id: TARGET_ID },
        data: { deletedAt: expect.any(Date) as Date },
      });
      expect(redisDel).toHaveBeenCalledWith(...VENUE_TYPE_CACHE_KEYS);
      expect(autoCreateLogs()).toHaveLength(0);
    });

    it('AC-1/AC-3/AC-7 · tombstone absent: creates a RESERVED row, logs it once, and re-points venues to it', async () => {
      tombstoneProbesReturn(null);
      venueType.create.mockResolvedValue({ id: CREATED_TOMBSTONE_ID });

      await service.softDelete(TARGET_ID);

      expect(venueType.create).toHaveBeenCalledTimes(1);
      expect(venueType.create).toHaveBeenCalledWith({
        data: { name: TOMBSTONE_VENUE_TYPE_NAME, isSystemReserved: true },
        select: { id: true },
      });
      expect(venue.updateMany).toHaveBeenCalledWith({
        where: { venueTypeId: TARGET_ID },
        data: { venueTypeId: CREATED_TOMBSTONE_ID },
      });
      expect(venueType.update).toHaveBeenCalledWith({
        where: { id: TARGET_ID },
        data: { deletedAt: expect.any(Date) as Date },
      });
      const logs = autoCreateLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(`id=${CREATED_TOMBSTONE_ID}`);
    });

    it('AC-6 · create loses the race with P2002: re-probes, reuses the winner, and the delete succeeds', async () => {
      tombstoneProbesReturn(null, EXISTING_TOMBSTONE_ID);
      venueType.create.mockRejectedValue(p2002());

      await service.softDelete(TARGET_ID);

      expect(tombstoneProbeCalls()).toHaveLength(2);
      expect(venue.updateMany).toHaveBeenCalledWith({
        where: { venueTypeId: TARGET_ID },
        data: { venueTypeId: EXISTING_TOMBSTONE_ID },
      });
      expect(venueType.update).toHaveBeenCalledTimes(1);
      // Nothing was created by THIS call, so it must not claim it was.
      expect(autoCreateLogs()).toHaveLength(0);
    });

    it('AC-6 · a non-P2002 create error propagates unchanged and nothing is moved or deleted', async () => {
      tombstoneProbesReturn(null);
      const boom = new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'x',
      });
      venueType.create.mockRejectedValue(boom);

      await expect(service.softDelete(TARGET_ID)).rejects.toBe(boom);

      // No re-probe on an error that is not a lost race.
      expect(tombstoneProbeCalls()).toHaveLength(1);
      expect($transaction).not.toHaveBeenCalled();
      expect(redisDel).not.toHaveBeenCalled();
      expect(autoCreateLogs()).toHaveLength(0);
    });

    it('a plain (non-Prisma) create error propagates unchanged', async () => {
      tombstoneProbesReturn(null);
      const boom = new Error('connection reset');
      venueType.create.mockRejectedValue(boom);

      await expect(service.softDelete(TARGET_ID)).rejects.toBe(boom);
      expect($transaction).not.toHaveBeenCalled();
    });

    it('P2002 with NO reserved row on re-probe (an ordinary row squats the name): rethrows once, never loops', async () => {
      tombstoneProbesReturn(null, null);
      const collision = p2002();
      venueType.create.mockRejectedValue(collision);

      await expect(service.softDelete(TARGET_ID)).rejects.toBe(collision);

      expect(venueType.create).toHaveBeenCalledTimes(1);
      expect(tombstoneProbeCalls()).toHaveLength(2);
      expect($transaction).not.toHaveBeenCalled();
    });

    it('AC-4 · a second delete reuses the auto-created tombstone — created exactly once', async () => {
      // First delete: probe misses and creates. Second delete: probe finds the row just created.
      tombstoneProbesReturn(null, CREATED_TOMBSTONE_ID);
      venueType.create.mockResolvedValue({ id: CREATED_TOMBSTONE_ID });

      await service.softDelete(TARGET_ID);
      await service.softDelete(TARGET_ID + 1);

      expect(venueType.create).toHaveBeenCalledTimes(1);
      expect(venue.updateMany).toHaveBeenNthCalledWith(1, {
        where: { venueTypeId: TARGET_ID },
        data: { venueTypeId: CREATED_TOMBSTONE_ID },
      });
      expect(venue.updateMany).toHaveBeenNthCalledWith(2, {
        where: { venueTypeId: TARGET_ID + 1 },
        data: { venueTypeId: CREATED_TOMBSTONE_ID },
      });
      expect(autoCreateLogs()).toHaveLength(1);
    });

    it('an unknown / reserved target is a 404 before any tombstone work happens', async () => {
      venueType.findFirst.mockResolvedValue(null);

      await expect(service.softDelete(TARGET_ID)).rejects.toThrow(
        new NotFoundException(OPTION_NOT_FOUND),
      );
      expect(venueType.findFirst).toHaveBeenCalledTimes(1);
      expect(venueType.create).not.toHaveBeenCalled();
      expect($transaction).not.toHaveBeenCalled();
    });
  });
});
