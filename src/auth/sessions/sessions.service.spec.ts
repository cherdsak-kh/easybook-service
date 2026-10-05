import { createHash } from 'node:crypto';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CANNOT_REVOKE_CURRENT_SESSION,
  SESSION_NOT_FOUND,
} from './sessions.constants';
import { SessionsService } from './sessions.service';
import type {
  SessionTrackerService,
  TrackedSession,
} from './session-tracker.service';

const NOW = 1_800_000_000_000;

/** A stand-in handle that does not contain the sid, like the real HMAC. */
const handleFor = (sid: string): string =>
  createHash('sha256').update(sid).digest('base64url').slice(0, 22);
const FIREFOX =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Firefox/129.0';

const tracked = (
  sid: string,
  lastActiveAt: number,
  loginAt = NOW - 100_000,
): TrackedSession => ({
  sid,
  handle: handleFor(sid),
  loginAt,
  lastActiveAt,
  ip: '203.0.113.7',
  userAgent: FIREFOX,
});

describe('SessionsService', () => {
  const list = jest.fn();
  const resolveHandle = jest.fn();
  const revokeOne = jest.fn();
  const revokeAll = jest.fn();
  const handleOf = jest.fn(handleFor);
  const tracker = {
    list,
    resolveHandle,
    revokeOne,
    revokeAll,
    handleOf,
  } as unknown as SessionTrackerService;

  const ctx = {
    userId: 'u1',
    sid: 'current',
    session: {
      createdAt: NOW - 50_000,
      ip: '198.51.100.9',
      userAgent: FIREFOX,
    },
  };

  let service: SessionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    service = new SessionsService(tracker);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('list (E1)', () => {
    it('builds `current` from the request session, not from the index', async () => {
      list.mockResolvedValue([]);
      const res = await service.list(ctx);

      expect(res.current).toMatchObject({
        isCurrent: true,
        ipAddress: '198.51.100.9',
        device: { os: 'Linux', browser: 'Firefox' },
        loginAt: new Date(NOW - 50_000).toISOString(),
        lastActiveAt: new Date(NOW).toISOString(),
      });
      expect(res.others).toEqual([]);
    });

    it('renders a pre-deploy current session as ip null / device unknown', async () => {
      list.mockResolvedValue([]);
      const res = await service.list({
        ...ctx,
        session: { createdAt: NOW - 5000 },
      });
      expect(res.current.ipAddress).toBeNull();
      expect(res.current.device).toMatchObject({
        deviceType: 'unknown',
        os: null,
        browser: null,
      });
    });

    it('excludes the current sid from `others` and sorts by lastActiveAt DESC, ties by loginAt DESC', async () => {
      list.mockResolvedValue([
        tracked('current', NOW),
        tracked('old', NOW - 9000),
        tracked('tieEarlier', NOW - 3000, NOW - 90_000),
        tracked('tieLater', NOW - 3000, NOW - 10_000),
        tracked('newest', NOW - 1000),
      ]);

      const res = await service.list(ctx);

      expect(res.others.map((o) => o.handle)).toEqual(
        ['newest', 'tieLater', 'tieEarlier', 'old'].map(handleFor),
      );
      expect(res.others.every((o) => o.isCurrent === false)).toBe(true);
    });

    it('never puts a raw sid in the response', async () => {
      list.mockResolvedValue([tracked('SECRET-SID-1', NOW - 1000)]);
      const res = await service.list({ ...ctx, sid: 'SECRET-SID-0' });
      expect(JSON.stringify(res)).not.toContain('SECRET-SID');
    });
  });

  describe('revokeOthers (E2)', () => {
    it('passes the current sid as `except` and returns the count', async () => {
      revokeAll.mockResolvedValue(2);
      await expect(service.revokeOthers(ctx)).resolves.toEqual({ revoked: 2 });
      expect(revokeAll).toHaveBeenCalledWith('u1', { except: 'current' });
    });

    it('is idempotent: 0 is a normal answer', async () => {
      revokeAll.mockResolvedValue(0);
      await expect(service.revokeOthers(ctx)).resolves.toEqual({ revoked: 0 });
    });
  });

  describe('revokeOne (E3)', () => {
    const FOREIGN = 'A'.repeat(22);

    it("is a 400 for the caller's own current handle, before touching Redis", async () => {
      await expect(service.revokeOne(ctx, handleOf('current'))).rejects.toEqual(
        new BadRequestException(CANNOT_REVOKE_CURRENT_SESSION),
      );
      expect(resolveHandle).not.toHaveBeenCalled();
    });

    it('is the same 404 for a malformed handle, an unknown one and a foreign one (AC-7)', async () => {
      resolveHandle.mockResolvedValue(null);
      const outcomes = await Promise.all(
        ['abc', 'others', FOREIGN, 'B'.repeat(22)].map((handle) =>
          service.revokeOne(ctx, handle).catch((e: NotFoundException) => ({
            status: e.getStatus(),
            body: e.getResponse(),
          })),
        ),
      );
      expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
      expect(outcomes[0]).toEqual({
        status: 404,
        body: new NotFoundException(SESSION_NOT_FOUND).getResponse(),
      });
    });

    it('does not even search Redis for a handle that cannot be one', async () => {
      await expect(service.revokeOne(ctx, 'others')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(resolveHandle).not.toHaveBeenCalled();
    });

    it("resolves against the caller's own sessions and revokes the matching sid", async () => {
      resolveHandle.mockResolvedValue(tracked('B', NOW));
      revokeOne.mockResolvedValue(true);

      await expect(service.revokeOne(ctx, FOREIGN)).resolves.toEqual({
        revoked: 1,
      });
      expect(resolveHandle).toHaveBeenCalledWith('u1', FOREIGN);
      expect(revokeOne).toHaveBeenCalledWith('u1', 'B');
    });

    it('is a 404 when the key expired between the read and the write', async () => {
      resolveHandle.mockResolvedValue(tracked('B', NOW));
      revokeOne.mockResolvedValue(false);
      await expect(service.revokeOne(ctx, FOREIGN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lets a 503 from the tracker through', async () => {
      resolveHandle.mockRejectedValue(new ServiceUnavailableException('x'));
      await expect(service.revokeOne(ctx, FOREIGN)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
