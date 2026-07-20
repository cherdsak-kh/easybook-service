import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_FIELDS } from '../../system-users/system-users.fields';
import {
  MUST_CHANGE_PASSWORD,
  SESSION_ABSOLUTE_MAX_AGE_MS,
} from '../auth.constants';
import type { RequestWithSystemUser } from '../auth.types';
import { SessionGuard } from './session.guard';

const dbRow = {
  id: 'user-1',
  email: 'ada@easybook.local',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: SystemRole.SUPER_ADMIN,
  department: { id: 7, name: 'IT' },
  personnelRole: { id: 9, name: 'Director' },
  mustChangePassword: false,
  phoneNumber: null,
  profilePictureUrl: null,
  isActive: true,
  lastLoginAt: null,
  lineUserId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  deletedAt: null,
};

describe('SessionGuard', () => {
  let guard: SessionGuard;
  const findUnique = jest.fn();
  const destroy = jest.fn((cb: (err?: unknown) => void) => cb());
  const getAllAndOverride = jest.fn();

  const prisma = { systemUser: { findUnique } } as unknown as PrismaService;
  const reflector = { getAllAndOverride } as unknown as Reflector;

  const makeRequest = (
    session?: Partial<{ systemUserId: string; createdAt: number }>,
  ): RequestWithSystemUser =>
    ({
      session: session ? { ...session, destroy } : undefined,
    }) as unknown as RequestWithSystemUser;

  const contextFor = (req: RequestWithSystemUser): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    getAllAndOverride.mockReturnValue(undefined); // deny by default — no decorator present
    guard = new SessionGuard(prisma, reflector);
  });

  it('rejects a request with no session', async () => {
    await expect(guard.canActivate(contextFor(makeRequest()))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects a session with no systemUserId', async () => {
    await expect(
      guard.canActivate(contextFor(makeRequest({ createdAt: Date.now() }))),
    ).rejects.toThrow(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('destroys and rejects a session past the 24h absolute cap', async () => {
    const req = makeRequest({
      systemUserId: 'user-1',
      createdAt: Date.now() - SESSION_ABSOLUTE_MAX_AGE_MS - 1,
    });

    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(destroy).toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('re-reads the user from the DB on every request and never selects the password digest (D-9, AC-5)', async () => {
    findUnique.mockResolvedValue(dbRow);
    const req = makeRequest({ systemUserId: 'user-1', createdAt: Date.now() });

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { ...PUBLIC_FIELDS, deletedAt: true },
    });
    // The select is exactly PUBLIC_FIELDS + deletedAt, and PUBLIC_FIELDS carries no digest.
    expect(Object.keys(PUBLIC_FIELDS)).not.toContain('passwordHash');
  });

  it('strips deletedAt before attaching the user, so it cannot leak via GET /auth/system/me (AC-32)', async () => {
    findUnique.mockResolvedValue(dbRow);
    const req = makeRequest({ systemUserId: 'user-1', createdAt: Date.now() });

    await guard.canActivate(contextFor(req));

    expect(req.systemUser).toBeDefined();
    expect(Object.keys(req.systemUser!).sort()).toEqual(
      Object.keys(PUBLIC_FIELDS).sort(),
    );
    expect('deletedAt' in req.systemUser!).toBe(false);
  });

  it.each([
    ['the user vanished', null],
    [
      'the user is soft-deleted but still isActive (AC-31, AC-58)',
      { ...dbRow, deletedAt: new Date() },
    ],
    [
      'the user was deactivated mid-session (AC-27)',
      { ...dbRow, isActive: false },
    ],
  ])('destroys the session and returns 401 when %s', async (_label, row) => {
    findUnique.mockResolvedValue(row);
    const req = makeRequest({ systemUserId: 'user-1', createdAt: Date.now() });

    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(req.systemUser).toBeUndefined();
  });

  it('still returns 401 when destroying the rejected session itself fails', async () => {
    findUnique.mockResolvedValue({ ...dbRow, isActive: false });
    destroy.mockImplementationOnce((cb: (err?: unknown) => void) =>
      cb(new Error('redis down')),
    );
    const req = makeRequest({ systemUserId: 'user-1', createdAt: Date.now() });

    await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // ─────────────────── the forced-reset gate (AC-B8/AC-B9) ───────────────────

  describe('forced-reset gate', () => {
    const gatedRow = { ...dbRow, mustChangePassword: true };
    const live = () =>
      makeRequest({ systemUserId: 'user-1', createdAt: Date.now() });

    it('AC-B8 — 403s a gated user on a NON-exempt handler, and keeps the session alive', async () => {
      findUnique.mockResolvedValue(gatedRow);
      const req = live();

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
        new ForbiddenException(MUST_CHANGE_PASSWORD),
      );
      // The session SURVIVES: this is a credential state, not a lifecycle failure. Destroying it
      // would strand the user at a login screen whose password is the one they must change.
      expect(destroy).not.toHaveBeenCalled();
    });

    it('lets a gated user through a handler carrying @AllowPasswordChangeGate()', async () => {
      findUnique.mockResolvedValue(gatedRow);
      getAllAndOverride.mockReturnValue(true);
      const req = live();

      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
      expect(req.systemUser?.mustChangePassword).toBe(true);
    });

    it('reads the exemption from the handler AND the class, in that order', async () => {
      findUnique.mockResolvedValue(gatedRow);
      getAllAndOverride.mockReturnValue(true);

      await guard.canActivate(contextFor(live()));

      expect(getAllAndOverride).toHaveBeenCalledWith(
        'allowPasswordChangeGate',
        expect.arrayContaining([expect.anything(), expect.anything()]),
      );
    });

    it('AC-B9 — a user with mustChangePassword=false passes everywhere, with no exemption needed', async () => {
      findUnique.mockResolvedValue(dbRow); // mustChangePassword: false
      await expect(guard.canActivate(contextFor(live()))).resolves.toBe(true);
    });

    it('costs no extra query — the flag rides along on the row already read', async () => {
      findUnique.mockResolvedValue(gatedRow);
      getAllAndOverride.mockReturnValue(true);

      await guard.canActivate(contextFor(live()));

      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(Object.keys(PUBLIC_FIELDS)).toContain('mustChangePassword');
    });

    it.each([
      ['soft-deleted', { ...gatedRow, deletedAt: new Date() }],
      ['suspended', { ...gatedRow, isActive: false }],
    ])(
      'ORDERING — a %s user gets 401 (session destroyed) even while gated: the lifecycle flags win',
      async (_label, row) => {
        findUnique.mockResolvedValue(row);
        const req = live();

        // NOT a 403: a suspended or deleted user must never reach the reset screen and rotate
        // their own credential.
        await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
          UnauthorizedException,
        );
        expect(destroy).toHaveBeenCalledTimes(1);
      },
    );
  });
});
