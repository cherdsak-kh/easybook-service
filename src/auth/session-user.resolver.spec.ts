import { SystemRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_FIELDS } from '../system-users/system-users.fields';
import { SESSION_ABSOLUTE_MAX_AGE_MS } from './auth.constants';
import {
  resolveSessionUser,
  resolveSystemUserById,
} from './session-user.resolver';

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
  createdBy: { id: 'sa-0', firstName: 'Seed', lastName: 'Admin' },
  updatedAt: new Date('2026-07-02T00:00:00.000Z'),
  deletedAt: null,
};

describe('resolveSessionUser', () => {
  const findUnique = jest.fn();
  const prisma = { systemUser: { findUnique } } as unknown as PrismaService;
  const live = { systemUserId: 'user-1', createdAt: Date.now() };

  beforeEach(() => jest.clearAllMocks());

  it('NO_SESSION when there is no session at all — and issues no query', async () => {
    await expect(resolveSessionUser(prisma, undefined)).resolves.toEqual({
      ok: false,
      reason: 'NO_SESSION',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('NO_SESSION when the session carries no systemUserId — and issues no query', async () => {
    await expect(
      resolveSessionUser(prisma, { createdAt: Date.now() }),
    ).resolves.toEqual({ ok: false, reason: 'NO_SESSION' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('SESSION_EXPIRED past the absolute cap, BEFORE any DB read', async () => {
    await expect(
      resolveSessionUser(prisma, {
        systemUserId: 'user-1',
        createdAt: Date.now() - SESSION_ABSOLUTE_MAX_AGE_MS - 1,
      }),
    ).resolves.toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('SESSION_EXPIRED when createdAt is missing (epoch 0 is always past the cap)', async () => {
    await expect(
      resolveSessionUser(prisma, { systemUserId: 'user-1' }),
    ).resolves.toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
  });

  it('USER_NOT_FOUND when the session points at a row that is gone', async () => {
    findUnique.mockResolvedValue(null);
    await expect(resolveSessionUser(prisma, live)).resolves.toEqual({
      ok: false,
      reason: 'USER_NOT_FOUND',
    });
  });

  // `isActive` and `deletedAt` are ORTHOGONAL: a soft-deleted user is normally still isActive.
  it.each([
    ['soft-deleted but still isActive', { ...dbRow, deletedAt: new Date() }],
    ['suspended but not deleted', { ...dbRow, isActive: false }],
    ['both', { ...dbRow, deletedAt: new Date(), isActive: false }],
  ])('USER_REVOKED when the user is %s', async (_label, row) => {
    findUnique.mockResolvedValue(row);
    await expect(resolveSessionUser(prisma, live)).resolves.toEqual({
      ok: false,
      reason: 'USER_REVOKED',
    });
  });

  it('resolves a live user and re-reads it from the DB (D-9), never selecting the digest', async () => {
    findUnique.mockResolvedValue(dbRow);

    const result = await resolveSessionUser(prisma, live);

    expect(result.ok).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { ...PUBLIC_FIELDS, deletedAt: true },
    });
    expect(Object.keys(PUBLIC_FIELDS)).not.toContain('passwordHash');
  });

  it('selects deletedAt only to check it, and STRIPS it from the returned user', async () => {
    findUnique.mockResolvedValue(dbRow);

    const result = await resolveSessionUser(prisma, live);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('deletedAt' in result.user).toBe(false);
    expect(Object.keys(result.user).sort()).toEqual(
      Object.keys(PUBLIC_FIELDS).sort(),
    );
  });

  it('does NOT gate on mustChangePassword — each caller applies its own policy', async () => {
    findUnique.mockResolvedValue({ ...dbRow, mustChangePassword: true });

    const result = await resolveSessionUser(prisma, live);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.mustChangePassword).toBe(true);
  });

  it('never destroys, saves or touches the session — it only reads the payload', async () => {
    findUnique.mockResolvedValue(dbRow);
    const destroy = jest.fn();
    const save = jest.fn();
    const touch = jest.fn();

    await resolveSessionUser(prisma, {
      ...live,
      destroy,
      save,
      touch,
    } as never);

    expect(destroy).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  describe('resolveSystemUserById (the sweep entry point)', () => {
    it('performs the same PK read and the same revocation checks', async () => {
      findUnique.mockResolvedValue({ ...dbRow, isActive: false });

      await expect(resolveSystemUserById(prisma, 'user-1')).resolves.toEqual({
        ok: false,
        reason: 'USER_REVOKED',
      });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { ...PUBLIC_FIELDS, deletedAt: true },
      });
    });
  });
});
