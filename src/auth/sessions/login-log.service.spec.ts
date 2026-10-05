import { LoginEventStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginLogService } from './login-log.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-04T10:00:00.000Z');
const FIREFOX =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Firefox/129.0';

/** The first argument of a mock's first call, typed as `unknown` rather than leaking `any`. */
const firstArg = (fn: jest.Mock): unknown =>
  (fn.mock.calls as unknown[][])[0][0];

describe('LoginLogService', () => {
  const create = jest.fn();
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const count = jest.fn();
  const deleteMany = jest.fn();
  const $transaction = jest.fn((ops: Array<Promise<unknown>>) =>
    Promise.all(ops),
  );

  const prisma = {
    systemUserLoginLog: { create, findMany, findFirst, count, deleteMany },
    $transaction,
  } as unknown as PrismaService;

  let service: LoginLogService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);
    service = new LoginLogService(prisma);
    jest
      .spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('retentionCutoff', () => {
    it('is exactly 90 days before now', () => {
      expect(service.retentionCutoff(NOW).getTime()).toBe(
        NOW.getTime() - 90 * DAY_MS,
      );
    });
  });

  describe('recordSuccess / recordFailure', () => {
    it('writes a SUCCESS row carrying the session handle, never a raw sid', async () => {
      create.mockResolvedValue({ id: 'x' });
      await service.recordSuccess('u1', '203.0.113.7', FIREFOX, 'handle-22');

      expect(create).toHaveBeenCalledWith({
        data: {
          systemUserId: 'u1',
          status: LoginEventStatus.SUCCESS,
          ipAddress: '203.0.113.7',
          userAgent: FIREFOX,
          sessionRef: 'handle-22',
        },
        select: { id: true },
      });
    });

    it('writes a FAILED_BAD_PASSWORD row with no sessionRef', async () => {
      create.mockResolvedValue({ id: 'x' });
      await service.recordFailure('u1', '203.0.113.7', FIREFOX);

      const arg = firstArg(create) as { data: Record<string, unknown> };
      expect(arg.data.status).toBe(LoginEventStatus.FAILED_BAD_PASSWORD);
      expect(arg.data).not.toHaveProperty('sessionRef');
    });

    it('clips the ip to 64 chars and the UA to 512, stripping control characters', async () => {
      create.mockResolvedValue({ id: 'x' });
      await service.recordFailure(
        'u1',
        'i'.repeat(100),
        `a\r\nb${'u'.repeat(600)}`,
      );

      const arg = firstArg(create) as {
        data: { ipAddress: string; userAgent: string };
      };
      expect(arg.data.ipAddress).toHaveLength(64);
      expect(arg.data.userAgent).toHaveLength(512);
      expect(arg.data.userAgent).not.toMatch(/[\r\n]/);
    });

    it('recordFailure RESOLVES even when the insert rejects (it runs fire-and-forget)', async () => {
      create.mockRejectedValue(new Error('db down'));
      await expect(
        service.recordFailure('u1', '203.0.113.7', FIREFOX),
      ).resolves.toBeUndefined();
    });

    it('recordSuccess resolves when the insert rejects, and logs no IP or UA', async () => {
      const warn = jest.spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      );
      create.mockRejectedValue(
        new Error(`Invalid create() with ip 203.0.113.7 and ua ${FIREFOX}`),
      );
      await expect(
        service.recordSuccess('u1', '203.0.113.7', FIREFOX, 'h'),
      ).resolves.toBeUndefined();

      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('id=u1');
      expect(logged).not.toContain('203.0.113.7');
      expect(logged).not.toContain('Firefox');
    });
  });

  describe('recordForceRevoked', () => {
    it('stores the target, the actor, and NO ip or user agent (R-10)', async () => {
      create.mockResolvedValue({ id: 'x' });
      await service.recordForceRevoked('target', 'actor');

      expect(create).toHaveBeenCalledWith({
        data: {
          systemUserId: 'target',
          status: LoginEventStatus.FORCE_REVOKED,
          actorId: 'actor',
        },
        select: { id: true },
      });
    });

    it('lets a failure propagate — the caller decides what an audit failure means', async () => {
      create.mockRejectedValue(new Error('db down'));
      await expect(
        service.recordForceRevoked('target', 'actor'),
      ).rejects.toThrow('db down');
    });
  });

  describe('listOwn', () => {
    const rows = [
      {
        id: 'c',
        status: LoginEventStatus.SUCCESS,
        createdAt: new Date('2026-10-04T09:00:00.000Z'),
        ipAddress: '203.0.113.7',
        userAgent: FIREFOX,
        sessionRef: 'HANDLE-CURRENT',
      },
      {
        id: 'b',
        status: LoginEventStatus.SUCCESS,
        createdAt: new Date('2026-10-03T09:00:00.000Z'),
        ipAddress: '198.51.100.2',
        userAgent: FIREFOX,
        sessionRef: 'HANDLE-OLD',
      },
      {
        id: 'a',
        status: LoginEventStatus.FORCE_REVOKED,
        createdAt: new Date('2026-10-02T09:00:00.000Z'),
        ipAddress: null,
        userAgent: null,
        sessionRef: null,
      },
    ];

    it('filters by the caller AND the 90-day cutoff, newest first with an id tie-break, and never selects actorId', async () => {
      findMany.mockResolvedValue(rows);
      count.mockResolvedValue(3);

      await service.listOwn('u1', 2, 10, 'HANDLE-CURRENT');

      const where = {
        systemUserId: 'u1',
        createdAt: { gte: new Date(NOW.getTime() - 90 * DAY_MS) },
      };
      expect(findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        take: 10,
        select: {
          id: true,
          status: true,
          createdAt: true,
          ipAddress: true,
          userAgent: true,
          sessionRef: true,
        },
      });
      expect(count).toHaveBeenCalledWith({ where });
      const select = (firstArg(findMany) as { select: object }).select;
      expect(select).not.toHaveProperty('actorId');
    });

    it('maps rows: parsed device, null device for FORCE_REVOKED, isCurrentSession only on the matching SUCCESS row', async () => {
      findMany.mockResolvedValue(rows);
      count.mockResolvedValue(3);

      const page = await service.listOwn('u1', 1, 10, 'HANDLE-CURRENT');

      expect(page.data.map((r) => r.id)).toEqual(['c', 'b', 'a']);
      expect(page.data[0].device).toMatchObject({
        os: 'Linux',
        browser: 'Firefox',
        browserVersion: '129',
      });
      expect(page.data.map((r) => r.isCurrentSession)).toEqual([
        true,
        false,
        false,
      ]);
      expect(page.data[2].device).toBeNull();
      expect(page.data[2].ipAddress).toBeNull();
      expect(page.data[0].createdAt).toBe('2026-10-04T09:00:00.000Z');
      // Nothing that identifies a session or an actor leaves the service.
      expect(JSON.stringify(page)).not.toContain('HANDLE-');
      expect(JSON.stringify(page)).not.toContain('actor');
    });

    it('a FORCE_REVOKED row is never "this device", even if a sessionRef matched', async () => {
      findMany.mockResolvedValue([
        { ...rows[2], sessionRef: 'HANDLE-CURRENT' },
      ]);
      count.mockResolvedValue(1);
      const page = await service.listOwn('u1', 1, 10, 'HANDLE-CURRENT');
      expect(page.data[0].isCurrentSession).toBe(false);
    });

    it('computes meta.totalPages, and 0 for an empty history', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(21);
      expect((await service.listOwn('u1', 999, 10, 'h')).meta).toEqual({
        page: 999,
        limit: 10,
        total: 21,
        totalPages: 3,
      });

      count.mockResolvedValue(0);
      expect((await service.listOwn('u1', 1, 10, 'h')).meta.totalPages).toBe(0);
    });
  });

  describe('latest', () => {
    it('looks up one status within the retention window', async () => {
      findFirst.mockResolvedValue(null);
      await service.latest('u1', LoginEventStatus.SUCCESS);

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          systemUserId: 'u1',
          status: LoginEventStatus.SUCCESS,
          createdAt: { gte: new Date(NOW.getTime() - 90 * DAY_MS) },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true, ipAddress: true, userAgent: true },
      });
    });
  });

  describe('purgeExpired (AC-20)', () => {
    it('deletes only rows older than 90 days and returns the count', async () => {
      deleteMany.mockResolvedValue({ count: 7 });

      await expect(service.purgeExpired(NOW)).resolves.toBe(7);

      expect(deleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: new Date(NOW.getTime() - 90 * DAY_MS) } },
      });
    });
  });
});
