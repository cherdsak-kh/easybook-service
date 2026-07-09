import { HttpException, UnauthorizedException } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { INVALID_CREDENTIALS } from './auth.constants';
import { loginIpEmailKey } from './login-throttle.key';
import { PasswordService } from './password.service';

/** Captures a rejected `HttpException` as a plain, comparable value. */
const captureHttpError = async (
  promise: Promise<unknown>,
): Promise<{ status: number; message: unknown }> => {
  try {
    await promise;
  } catch (e) {
    const error = e as HttpException;
    const body = error.getResponse() as { message?: unknown };
    return { status: error.getStatus(), message: body.message };
  }
  throw new Error('expected the promise to reject');
};

const DUMMY_HASH = '$argon2id$dummy';
const IP = '203.0.113.7';

const activeUser = {
  id: 'user-1',
  email: 'ada@easybook.local',
  name: 'Ada Lovelace',
  role: SystemRole.ADMIN,
  passwordHash: '$argon2id$real',
  isActive: true,
  deletedAt: null,
};

describe('AuthService', () => {
  let service: AuthService;

  const findUnique = jest.fn();
  const update = jest.fn();
  const del = jest.fn();
  const verify = jest.fn();

  const prisma = {
    systemUser: { findUnique, update },
  } as unknown as PrismaService;
  const password = {
    verify,
    dummyHash: () => Promise.resolve(DUMMY_HASH),
  } as unknown as PasswordService;
  const redis = { del } as unknown as import('ioredis').Redis;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(prisma, password, redis);
  });

  describe('validateCredentials', () => {
    it('returns the user on valid credentials', async () => {
      findUnique.mockResolvedValue(activeUser);
      verify.mockResolvedValue(true);

      await expect(
        service.validateCredentials('ada@easybook.local', 'correct', IP),
      ).resolves.toEqual({
        id: 'user-1',
        email: 'ada@easybook.local',
        name: 'Ada Lovelace',
        role: SystemRole.ADMIN,
      });
      expect(verify).toHaveBeenCalledWith('$argon2id$real', 'correct');
    });

    it('normalises the email before the lookup (trim + lowercase)', async () => {
      findUnique.mockResolvedValue(activeUser);
      verify.mockResolvedValue(true);

      await service.validateCredentials(
        '  Ada@EasyBook.Local  ',
        'correct',
        IP,
      );

      expect(findUnique).toHaveBeenCalledWith({
        where: { email: 'ada@easybook.local' },
      });
    });

    it('does NOT filter deletedAt in the lookup — the branch below decides (§9)', async () => {
      findUnique.mockResolvedValue(null);
      verify.mockResolvedValue(false);

      await expect(
        service.validateCredentials('nobody@easybook.local', 'x', IP),
      ).rejects.toThrow(UnauthorizedException);

      expect(findUnique).toHaveBeenCalledWith({
        where: { email: 'nobody@easybook.local' },
      });
    });

    // AC-6 / AC-31 — the four failures are byte-identical in status and message.
    const uniformFailures: Array<[string, unknown]> = [
      ['unknown email', null],
      ['soft-deleted user', { ...activeUser, deletedAt: new Date() }],
      ['suspended user', { ...activeUser, isActive: false }],
    ];

    it.each(uniformFailures)(
      'rejects a %s with the same 401 as a wrong password, after burning a dummy verify',
      async (_label, row) => {
        findUnique.mockResolvedValue(row);
        verify.mockResolvedValue(false);

        await expect(
          captureHttpError(
            service.validateCredentials('ada@easybook.local', 'whatever', IP),
          ),
        ).resolves.toEqual({ status: 401, message: INVALID_CREDENTIALS });

        // Timing-safe: the dummy hash is verified so a missing/deleted/suspended account is not
        // measurably faster than a real one with a wrong password.
        expect(verify).toHaveBeenCalledTimes(1);
        expect(verify).toHaveBeenCalledWith(DUMMY_HASH, 'whatever');
      },
    );

    it('rejects a wrong password with the identical 401 (AC-6)', async () => {
      findUnique.mockResolvedValue(activeUser);
      verify.mockResolvedValue(false);

      await expect(
        captureHttpError(
          service.validateCredentials('ada@easybook.local', 'wrong', IP),
        ),
      ).resolves.toEqual({ status: 401, message: INVALID_CREDENTIALS });
      expect(verify).toHaveBeenCalledWith('$argon2id$real', 'wrong');
    });

    it('never logs the submitted password', async () => {
      const warn = jest
        .spyOn(
          (service as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      findUnique.mockResolvedValue(null);
      verify.mockResolvedValue(false);

      await expect(
        service.validateCredentials('ada@easybook.local', 'hunter2', IP),
      ).rejects.toThrow(UnauthorizedException);

      const logged = warn.mock.calls.map(([m]) => m).join('\n');
      expect(logged).toContain('ada@easybook.local');
      expect(logged).toContain(IP);
      expect(logged).not.toContain('hunter2');
    });
  });

  describe('touchLastLogin', () => {
    it('stamps lastLoginAt (AC-9)', async () => {
      update.mockResolvedValue({ id: 'user-1' });

      await service.touchLastLogin('user-1');

      expect(update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { lastLoginAt: expect.any(Date) as unknown },
        select: { id: true },
      });
    });
  });

  describe('clearLoginThrottle', () => {
    it('deletes the (ip + email) counter key only, never the per-IP one (AC-20, AC-21)', async () => {
      del.mockResolvedValue(1);

      await service.clearLoginThrottle(IP, '  Ada@EasyBook.Local ');

      expect(del).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledWith(
        loginIpEmailKey(IP, 'ada@easybook.local'),
      );
    });

    it('swallows a Redis failure — the session is already saved', async () => {
      del.mockRejectedValue(new Error('connection lost'));
      await expect(
        service.clearLoginThrottle(IP, 'ada@easybook.local'),
      ).resolves.toBeUndefined();
    });
  });
});
