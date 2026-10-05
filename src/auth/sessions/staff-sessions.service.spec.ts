import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LoginEventStatus, SystemRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { SYSTEM_USER_NOT_FOUND } from '../../system-users/system-users.errors';
import {
  CANNOT_REVOKE_OWN_SESSIONS,
  INSUFFICIENT_ROLE,
  type Actor,
} from '../../system-users/system-users.policy';
import type { LoginLogService } from './login-log.service';
import type { SessionTrackerService } from './session-tracker.service';
import { StaffSessionsService } from './staff-sessions.service';

const SA: Actor = {
  id: 'sa1',
  role: SystemRole.SUPER_ADMIN,
  createdById: null,
};
const FIREFOX =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Firefox/129.0';

describe('StaffSessionsService', () => {
  const findUnique = jest.fn();
  const list = jest.fn();
  const revokeAll = jest.fn();
  const latest = jest.fn();
  const recordForceRevoked = jest.fn();

  const prisma = { systemUser: { findUnique } } as unknown as PrismaService;
  const tracker = { list, revokeAll } as unknown as SessionTrackerService;
  const loginLog = { latest, recordForceRevoked } as unknown as LoginLogService;

  let service: StaffSessionsService;
  let loggerError: jest.SpyInstance;

  const target = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    isActive: true,
    deletedAt: null,
    lastLoginAt: null,
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    latest.mockResolvedValue(null);
    service = new StaffSessionsService(prisma, tracker, loginLog);
    const logger = (
      service as unknown as { logger: { log: () => void; error: () => void } }
    ).logger;
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    loggerError = jest
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('summary (E5)', () => {
    it('counts live sessions and reads the last login from the history', async () => {
      findUnique.mockResolvedValue(target());
      list.mockResolvedValue([{}, {}]);
      latest.mockImplementation((_id: string, status: LoginEventStatus) =>
        Promise.resolve(
          status === LoginEventStatus.SUCCESS
            ? {
                createdAt: new Date('2026-10-04T08:05:00.000Z'),
                ipAddress: '203.0.113.7',
                userAgent: FIREFOX,
              }
            : { createdAt: new Date('2026-10-03T01:00:00.000Z') },
        ),
      );

      await expect(service.summary('t1')).resolves.toEqual({
        activeSessionCount: 2,
        lastLogin: {
          at: '2026-10-04T08:05:00.000Z',
          device: {
            deviceType: 'desktop',
            os: 'Linux',
            osVersion: null,
            browser: 'Firefox',
            browserVersion: '129',
          },
          ipAddress: '203.0.113.7',
        },
        lastForceRevokedAt: '2026-10-03T01:00:00.000Z',
      });
    });

    it('a suspended target reports 0 and makes NO Redis call', async () => {
      findUnique.mockResolvedValue(target({ isActive: false }));
      const res = await service.summary('t1');
      expect(res.activeSessionCount).toBe(0);
      expect(list).not.toHaveBeenCalled();
    });

    it('falls back to lastLoginAt alone (no device, no ip) when the login predates the 90-day history', async () => {
      findUnique.mockResolvedValue(
        target({ lastLoginAt: new Date('2026-05-01T00:00:00.000Z') }),
      );
      list.mockResolvedValue([]);
      const res = await service.summary('t1');
      expect(res.lastLogin).toEqual({
        at: '2026-05-01T00:00:00.000Z',
        device: null,
        ipAddress: null,
      });
    });

    it('lastLogin is null for an account that never signed in', async () => {
      findUnique.mockResolvedValue(target());
      list.mockResolvedValue([]);
      const res = await service.summary('t1');
      expect(res.lastLogin).toBeNull();
      expect(res.lastForceRevokedAt).toBeNull();
    });

    it.each([
      ['unknown', null],
      ['soft-deleted', target({ deletedAt: new Date() })],
    ])('a %s target is the same 404', async (_label, row) => {
      findUnique.mockResolvedValue(row);
      await expect(service.summary('t1')).rejects.toEqual(
        new NotFoundException(SYSTEM_USER_NOT_FOUND),
      );
    });
  });

  describe('forceRevoke (E6)', () => {
    it('ends every session, writes ONE FORCE_REVOKED row against the target with the actor, and returns the count', async () => {
      findUnique.mockResolvedValue(target());
      revokeAll.mockResolvedValue(2);
      recordForceRevoked.mockResolvedValue(undefined);

      await expect(service.forceRevoke(SA, 't1')).resolves.toEqual({
        revoked: 2,
      });

      expect(revokeAll).toHaveBeenCalledWith('t1'); // no `except`
      expect(recordForceRevoked).toHaveBeenCalledTimes(1);
      expect(recordForceRevoked).toHaveBeenCalledWith('t1', 'sa1');
    });

    it('writes NO row when nothing was live (X-13), and still answers 200', async () => {
      findUnique.mockResolvedValue(target());
      revokeAll.mockResolvedValue(0);

      await expect(service.forceRevoke(SA, 't1')).resolves.toEqual({
        revoked: 0,
      });
      expect(recordForceRevoked).not.toHaveBeenCalled();
    });

    it('self is a 400 (OQ-5) — and nothing is looked up or revoked', async () => {
      await expect(service.forceRevoke(SA, 'sa1')).rejects.toEqual(
        new BadRequestException(CANNOT_REVOKE_OWN_SESSIONS),
      );
      expect(findUnique).not.toHaveBeenCalled();
      expect(revokeAll).not.toHaveBeenCalled();
    });

    it('a non-SUPER_ADMIN is a 403 (defence in depth behind @Roles), never a 400', async () => {
      await expect(
        service.forceRevoke(
          { id: 'adm', role: SystemRole.ADMIN, createdById: null },
          't1',
        ),
      ).rejects.toEqual(new ForbiddenException(INSUFFICIENT_ROLE));
      expect(revokeAll).not.toHaveBeenCalled();
    });

    it('SA → peer SA and SA → their own creator are allowed (OQ-5)', async () => {
      findUnique.mockResolvedValue(target({ id: 'creator' }));
      revokeAll.mockResolvedValue(1);
      recordForceRevoked.mockResolvedValue(undefined);

      await expect(
        service.forceRevoke({ ...SA, createdById: 'creator' }, 'creator'),
      ).resolves.toEqual({ revoked: 1 });
    });

    it('a suspended target IS revoked (its keys would otherwise revive on reactivation)', async () => {
      findUnique.mockResolvedValue(target({ isActive: false }));
      revokeAll.mockResolvedValue(1);
      recordForceRevoked.mockResolvedValue(undefined);

      await expect(service.forceRevoke(SA, 't1')).resolves.toEqual({
        revoked: 1,
      });
    });

    it.each([
      ['unknown', null],
      ['soft-deleted', target({ deletedAt: new Date() })],
    ])('a %s target is a 404 and revokes nothing', async (_label, row) => {
      findUnique.mockResolvedValue(row);
      await expect(service.forceRevoke(SA, 't1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(revokeAll).not.toHaveBeenCalled();
    });

    it('a Redis failure is a 503 and NO FORCE_REVOKED row is written', async () => {
      findUnique.mockResolvedValue(target());
      revokeAll.mockRejectedValue(new ServiceUnavailableException('x'));

      await expect(service.forceRevoke(SA, 't1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(recordForceRevoked).not.toHaveBeenCalled();
    });

    it('a failed audit insert after a successful EXEC is logged and still answers 200', async () => {
      findUnique.mockResolvedValue(target());
      revokeAll.mockResolvedValue(2);
      recordForceRevoked.mockRejectedValue(new Error('db down'));

      await expect(service.forceRevoke(SA, 't1')).resolves.toEqual({
        revoked: 2,
      });
      expect(loggerError).toHaveBeenCalledTimes(1);
    });
  });
});
