import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SystemRole } from '@prisma/client';
import { PasswordService } from '../auth/password.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemUsersService } from './system-users.service';
import {
  CONCURRENT_MODIFICATION,
  EMAIL_TAKEN,
  INVALID_DEPARTMENT,
  INVALID_PERSONNEL_ROLE,
  LAST_SUPER_ADMIN,
  SYSTEM_USER_NOT_FOUND,
  USER_NOT_DELETED,
} from './system-users.errors';
import { PUBLIC_FIELDS } from './system-users.fields';
import { CANNOT_RESET_OWN_PASSWORD } from './system-users.policy';
import type { Actor } from './system-users.policy';

const SUPER_ADMIN_ACTOR: Actor = { id: 'sa-1', role: SystemRole.SUPER_ADMIN };
const ADMIN_ACTOR: Actor = { id: 'ad-1', role: SystemRole.ADMIN };

const row = {
  id: 'sa-2',
  email: 'other@easybook.local',
  firstName: 'Other',
  lastName: 'Super Admin',
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
};

interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
}
interface WriteArgs {
  where: { id: string };
  data: Record<string, unknown>;
  select: unknown;
}

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

/** An error shaped like what `@prisma/adapter-pg` leaves unmapped for SQLSTATE 40P01. */
const rawSqlstateError = (code: string): Error => {
  const driver = Object.assign(new Error('deadlock/serialization'), { code });
  return Object.assign(
    new Error('Invalid `prisma.systemUser.update()` invocation'),
    {
      cause: driver,
    },
  );
};

describe('SystemUsersService', () => {
  let service: SystemUsersService;

  const txFindFirst = jest.fn();
  const txFindUnique = jest.fn();
  const txUpdate = jest.fn();
  const txCount = jest.fn();
  const txCreate = jest.fn();
  const txDepartmentFindFirst = jest.fn();
  const txPersonnelRoleFindFirst = jest.fn();
  const create = jest.fn();
  const findFirst = jest.fn();
  const findMany = jest.fn();
  const count = jest.fn();
  const update = jest.fn();
  const $transaction = jest.fn();

  const tx = {
    systemUser: {
      findFirst: txFindFirst,
      findUnique: txFindUnique,
      update: txUpdate,
      count: txCount,
      create: txCreate,
    },
    department: { findFirst: txDepartmentFindFirst },
    personnelRole: { findFirst: txPersonnelRoleFindFirst },
  } as unknown as Prisma.TransactionClient;

  const prisma = {
    systemUser: { create, findFirst, findMany, count, update },
    $transaction,
  } as unknown as PrismaService;

  // Standalone jest.fn()s (the spec's existing style for `create`, `findFirst`, …) so assertions
  // reference the mock directly rather than an unbound method off the service object.
  const hash = jest.fn().mockResolvedValue('$argon2id$x');
  const generateTemporaryPassword = jest
    .fn()
    .mockReturnValue('TempPassword123x');

  const password = {
    hash,
    generateTemporaryPassword,
  } as unknown as PasswordService;

  /** Runs the interactive-transaction callback, capturing its isolation options. */
  const runInteractiveTx = () =>
    $transaction.mockImplementation(
      async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx),
    );

  /** The isolation options `$transaction` was invoked with, if any. */
  const txOptionsOf = (callIndex = 0): TxOptions | undefined =>
    ($transaction.mock.calls[callIndex] as [unknown, TxOptions | undefined])[1];

  const writeArgsOf = (mock: jest.Mock, callIndex = 0): WriteArgs =>
    (mock.mock.calls[callIndex] as [WriteArgs])[0];

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SystemUsersService(prisma, password);
  });

  // ───────────────────────────── create ─────────────────────────────

  describe('create', () => {
    const dto = {
      email: 'Other@EasyBook.Local',
      firstName: 'Other',
      lastName: 'Super Admin',
      departmentId: 7,
      personnelRoleId: 9,
    };

    /** Both option lookups resolve; the insert returns `row`. */
    const happyPath = () => {
      runInteractiveTx();
      txDepartmentFindFirst.mockResolvedValue({ id: 7 });
      txPersonnelRoleFindFirst.mockResolvedValue({ id: 9 });
      txCreate.mockResolvedValue(row);
    };

    it('hashes the SERVER-issued temp password, stamps createdById, and selects only public fields', async () => {
      happyPath();

      await service.create('sa-1', dto);

      const args = txCreate.mock.calls[0] as [
        { data: Record<string, unknown>; select: unknown },
      ];
      expect(args[0].data).toMatchObject({
        email: 'other@easybook.local',
        createdById: 'sa-1',
        departmentId: 7,
        personnelRoleId: 9,
        mustChangePassword: true, // explicit, not left to the DB default
        phoneNumber: null,
        profilePictureUrl: null,
      });
      expect(args[0].select).toBe(PUBLIC_FIELDS);
    });

    it('AC-B7 — returns the temp password once and stores ONLY its digest, never the plaintext', async () => {
      happyPath();

      const result = await service.create('sa-1', dto);

      expect(result.temporaryPassword).toBe('TempPassword123x');
      expect(hash).toHaveBeenCalledWith('TempPassword123x');

      // The plaintext must never reach a column: the digest is what is written.
      const { data } = writeArgsOf(txCreate);
      expect(data.passwordHash).toBe('$argon2id$x');
      expect(JSON.stringify(data)).not.toContain('TempPassword123x');
    });

    it('AC-B3 — a soft-deleted or unknown departmentId is a 400, and nothing is written', async () => {
      runInteractiveTx();
      txDepartmentFindFirst.mockResolvedValue(null); // soft-deleted == absent to this check

      await expect(
        captureHttpError(service.create('sa-1', dto)),
      ).resolves.toEqual({ status: 400, message: INVALID_DEPARTMENT });
      expect(txCreate).not.toHaveBeenCalled();
    });

    it('AC-B3 — a soft-deleted or unknown personnelRoleId is a 400, and nothing is written', async () => {
      runInteractiveTx();
      txDepartmentFindFirst.mockResolvedValue({ id: 7 });
      txPersonnelRoleFindFirst.mockResolvedValue(null);

      await expect(
        captureHttpError(service.create('sa-1', dto)),
      ).resolves.toEqual({ status: 400, message: INVALID_PERSONNEL_ROLE });
      expect(txCreate).not.toHaveBeenCalled();
    });

    it('validates the options with an ACTIVE-only filter, inside the transaction', async () => {
      happyPath();
      await service.create('sa-1', dto);

      expect(txDepartmentFindFirst).toHaveBeenCalledWith({
        where: { id: 7, deletedAt: null },
        select: { id: true },
      });
      expect(txPersonnelRoleFindFirst).toHaveBeenCalledWith({
        where: { id: 9, deletedAt: null },
        select: { id: true },
      });
    });

    it('maps a unique-constraint violation to 409 with the generic message (AC-26, AC-33, AC-54)', async () => {
      runInteractiveTx();
      txDepartmentFindFirst.mockResolvedValue({ id: 7 });
      txPersonnelRoleFindFirst.mockResolvedValue({ id: 9 });
      txCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '7.8.0',
        }),
      );

      await expect(
        captureHttpError(
          service.create('sa-1', { ...dto, email: 'taken@easybook.local' }),
        ),
      ).resolves.toEqual({ status: 409, message: EMAIL_TAKEN });
    });

    it('never adds a deletedAt filter or a read-then-write pre-check for duplicates', async () => {
      happyPath();
      await service.create('sa-1', dto);
      expect(txFindFirst).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────── reset-password ─────────────────────────

  describe('resetPassword', () => {
    const target = { id: 'sa-2', role: SystemRole.STAFF };

    it('AC-B7 — issues a new temp password, sets mustChangePassword, returns the plaintext once', async () => {
      runInteractiveTx();
      txFindFirst.mockResolvedValue(target);
      txUpdate.mockResolvedValue(row);

      const result = await service.resetPassword(SUPER_ADMIN_ACTOR, 'sa-2');

      expect(result.temporaryPassword).toBe('TempPassword123x');
      const { data } = writeArgsOf(txUpdate);
      expect(data).toEqual({
        passwordHash: '$argon2id$x',
        mustChangePassword: true,
      });
      // Only the digest is written — never the plaintext.
      expect(JSON.stringify(data)).not.toContain('TempPassword123x');
    });

    it('resolves the target with a deletedAt filter — a soft-deleted id is a 404', async () => {
      runInteractiveTx();
      txFindFirst.mockResolvedValue(null);

      await expect(
        captureHttpError(service.resetPassword(SUPER_ADMIN_ACTOR, 'gone')),
      ).resolves.toEqual({ status: 404, message: SYSTEM_USER_NOT_FOUND });
      expect(txFindFirst).toHaveBeenCalledWith({
        where: { id: 'gone', deletedAt: null },
        select: { id: true, role: true },
      });
    });

    it('refuses a self-reset via the policy (403), and writes nothing', async () => {
      runInteractiveTx();
      txFindFirst.mockResolvedValue({
        id: 'sa-1',
        role: SystemRole.SUPER_ADMIN,
      });

      await expect(
        captureHttpError(service.resetPassword(SUPER_ADMIN_ACTOR, 'sa-1')),
      ).resolves.toEqual({ status: 403, message: CANNOT_RESET_OWN_PASSWORD });
      expect(txUpdate).not.toHaveBeenCalled();
    });

    it('never touches role, isActive or deletedAt, so the last-SUPER_ADMIN invariant is unreachable', async () => {
      runInteractiveTx();
      txFindFirst.mockResolvedValue(target);
      txUpdate.mockResolvedValue(row);

      await service.resetPassword(SUPER_ADMIN_ACTOR, 'sa-2');

      const { data } = writeArgsOf(txUpdate);
      expect(data).not.toHaveProperty('role');
      expect(data).not.toHaveProperty('isActive');
      expect(data).not.toHaveProperty('deletedAt');
      expect(txCount).not.toHaveBeenCalled(); // no invariant check
      expect(txOptionsOf()).toBeUndefined(); // and therefore no Serializable
    });
  });

  // ───────────────────────── read paths ─────────────────────────

  describe('findManyPaginated', () => {
    it('filters soft-deleted rows from both data and total, and uses RepeatableRead (DD-16, AC-40)', async () => {
      $transaction.mockResolvedValue([[row], 1]);

      const result = await service.findManyPaginated({ page: 2, limit: 20 });

      const [operations, options] = $transaction.mock.calls[0] as [
        unknown[],
        TxOptions,
      ];
      expect(operations).toHaveLength(2);
      expect(options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      expect(findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        select: PUBLIC_FIELDS,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 20,
      });
      expect(count).toHaveBeenCalledWith({ where: { deletedAt: null } });
      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it('reports totalPages 0 when there are no rows, and never 404s a page past the end (AC-39)', async () => {
      $transaction.mockResolvedValue([[], 0]);

      const result = await service.findManyPaginated({ page: 999, limit: 20 });

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({
        page: 999,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('serialises dates as ISO strings', async () => {
      $transaction.mockResolvedValue([[row], 1]);
      const result = await service.findManyPaginated({ page: 1, limit: 20 });
      expect(result.data[0].createdAt).toBe('2026-07-01T00:00:00.000Z');
      expect(result.data[0].lastLoginAt).toBeNull();
    });
  });

  describe('findOne', () => {
    it('filters deletedAt: null, so a soft-deleted id is a 404 identical to an unknown id (AC-41)', async () => {
      findFirst.mockResolvedValue(null);

      await expect(captureHttpError(service.findOne('nope'))).resolves.toEqual({
        status: 404,
        message: SYSTEM_USER_NOT_FOUND,
      });
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'nope', deletedAt: null },
        select: PUBLIC_FIELDS,
      });
    });
  });

  // ───────────────────────── update ─────────────────────────

  describe('update', () => {
    beforeEach(() => {
      runInteractiveTx();
      txFindFirst.mockResolvedValue({ id: 'staff-1', role: SystemRole.STAFF });
      txUpdate.mockResolvedValue(row);
      txCount.mockResolvedValue(1);
    });

    it('loads the target with deletedAt: null and 404s a soft-deleted id (AC-53)', async () => {
      txFindFirst.mockResolvedValue(null);

      await expect(
        service.update(SUPER_ADMIN_ACTOR, 'gone', { firstName: 'X' }),
      ).rejects.toThrow(NotFoundException);
      expect(txFindFirst).toHaveBeenCalledWith({
        where: { id: 'gone', deletedAt: null },
        select: { id: true, role: true },
      });
      expect(txUpdate).not.toHaveBeenCalled();
    });

    it('applies the policy inside the transaction, and writes nothing on denial (AC-43)', async () => {
      txFindFirst.mockResolvedValue({ id: 'ad-2', role: SystemRole.ADMIN });

      await expect(
        service.update(ADMIN_ACTOR, 'ad-2', { firstName: 'X' }),
      ).rejects.toThrow(ForbiddenException);
      expect(txUpdate).not.toHaveBeenCalled();
    });

    it('builds `data` field by field — exactly the eight DTO fields, never a spread (DD-13, AC-60)', async () => {
      await service.update(SUPER_ADMIN_ACTOR, 'staff-1', { firstName: 'Ada' });

      const { data, select } = writeArgsOf(txUpdate);
      expect(Object.keys(data).sort()).toEqual([
        'departmentId',
        'firstName',
        'isActive',
        'lastName',
        'personnelRoleId',
        'phoneNumber',
        'profilePictureUrl',
        'role',
      ]);
      for (const forbidden of [
        'passwordHash',
        'email',
        'deletedAt',
        'lineUserId',
        'id',
      ]) {
        expect(Object.keys(data)).not.toContain(forbidden);
      }
      expect(select).toBe(PUBLIC_FIELDS);
    });

    it('passes an explicit null straight through to Prisma so the column is cleared (AC-62)', async () => {
      await service.update(SUPER_ADMIN_ACTOR, 'staff-1', {
        phoneNumber: null,
        profilePictureUrl: null,
      });

      const { data } = writeArgsOf(txUpdate);
      expect(data.phoneNumber).toBeNull();
      expect(data.profilePictureUrl).toBeNull();
      // Absent keys stay `undefined`, which Prisma omits from the UPDATE.
      expect(data.firstName).toBeUndefined();
    });

    // DD-9 — the isolation level is scoped to invariant-threatening writes.
    it('runs a profile-only patch at DEFAULT isolation and skips the invariant count', async () => {
      await service.update(SUPER_ADMIN_ACTOR, 'staff-1', { firstName: 'Ada' });

      expect(txOptionsOf()).toBeUndefined();
      expect(txCount).not.toHaveBeenCalled();
    });

    it.each([
      ['role', { role: SystemRole.STAFF }],
      ['isActive', { isActive: false }],
    ])(
      'runs a patch containing `%s` at Serializable and checks the invariant',
      async (_label, patch) => {
        await service.update(SUPER_ADMIN_ACTOR, 'staff-1', patch);

        expect(txOptionsOf()).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
        expect(txCount).toHaveBeenCalledWith({
          where: {
            role: SystemRole.SUPER_ADMIN,
            isActive: true,
            deletedAt: null,
          },
        });
      },
    );

    it('counts AFTER the write, inside the same transaction (not a TOCTOU pre-check)', async () => {
      const order: string[] = [];
      txUpdate.mockImplementation(() => {
        order.push('update');
        return Promise.resolve(row);
      });
      txCount.mockImplementation(() => {
        order.push('count');
        return Promise.resolve(1);
      });

      await service.update(SUPER_ADMIN_ACTOR, 'staff-1', { isActive: false });

      expect(order).toEqual(['update', 'count']);
    });

    // AC-50 — unreachable end to end by design (§6.4), so it is proven here.
    it.each([
      ['demoting', { role: SystemRole.STAFF }],
      ['deactivating', { isActive: false }],
    ])(
      '%s the last active SUPER_ADMIN is a 409 and rolls back (AC-50)',
      async (_label, patch) => {
        txFindFirst.mockResolvedValue({
          id: 'sa-2',
          role: SystemRole.SUPER_ADMIN,
        });
        txCount.mockResolvedValue(0);

        await expect(
          captureHttpError(service.update(SUPER_ADMIN_ACTOR, 'sa-2', patch)),
        ).resolves.toEqual({ status: 409, message: LAST_SUPER_ADMIN });
      },
    );

    // AC-51 — a lost write race must be a 409, never a 500.
    it('maps a Prisma P2034 write conflict to 409 (AC-51)', async () => {
      $transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('write conflict', {
          code: 'P2034',
          clientVersion: '7.8.0',
        }),
      );

      await expect(
        captureHttpError(
          service.update(SUPER_ADMIN_ACTOR, 'sa-2', { isActive: false }),
        ),
      ).resolves.toEqual({ status: 409, message: CONCURRENT_MODIFICATION });
    });

    it.each(['40001', '40P01'])(
      'maps a raw SQLSTATE %s the adapter left unmapped to 409, never 500 (DD-10, AC-51)',
      async (sqlstate) => {
        $transaction.mockRejectedValue(rawSqlstateError(sqlstate));

        await expect(
          captureHttpError(
            service.update(SUPER_ADMIN_ACTOR, 'sa-2', { isActive: false }),
          ),
        ).resolves.toEqual({ status: 409, message: CONCURRENT_MODIFICATION });
      },
    );

    it('lets a genuine unexpected error through unchanged (no blanket 409)', async () => {
      $transaction.mockRejectedValue(new Error('disk on fire'));
      await expect(
        service.update(SUPER_ADMIN_ACTOR, 'staff-1', { firstName: 'X' }),
      ).rejects.toThrow('disk on fire');
    });

    it('re-throws a 404/403/409 raised inside the transaction unchanged', async () => {
      $transaction.mockRejectedValue(
        new NotFoundException(SYSTEM_USER_NOT_FOUND),
      );
      await expect(
        service.update(SUPER_ADMIN_ACTOR, 'x', { firstName: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────── softDelete ─────────────────────────

  describe('softDelete', () => {
    beforeEach(() => {
      runInteractiveTx();
      txFindFirst.mockResolvedValue({ id: 'staff-1', role: SystemRole.STAFF });
      txUpdate.mockResolvedValue({ id: 'staff-1' });
      txCount.mockResolvedValue(1);
    });

    it('sets deletedAt via `update` — never `delete` (AC-52)', async () => {
      await service.softDelete(SUPER_ADMIN_ACTOR, 'staff-1');

      const { where, data, select } = writeArgsOf(txUpdate);
      expect(where).toEqual({ id: 'staff-1' });
      expect(Object.keys(data)).toEqual(['deletedAt']);
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(select).toEqual({ id: true });
      // The transaction client this service is handed exposes no hard-delete method at all.
      expect(
        (tx.systemUser as unknown as Record<string, unknown>).delete,
      ).toBeUndefined();
      expect(
        (tx.systemUser as unknown as Record<string, unknown>).deleteMany,
      ).toBeUndefined();
    });

    it('always runs at Serializable and always checks the invariant', async () => {
      await service.softDelete(SUPER_ADMIN_ACTOR, 'staff-1');

      expect(txOptionsOf()).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      expect(txCount).toHaveBeenCalledTimes(1);
    });

    it('404s an already-deleted id and an id that never existed, identically (AC-53)', async () => {
      txFindFirst.mockResolvedValue(null);

      await expect(
        captureHttpError(service.softDelete(SUPER_ADMIN_ACTOR, 'gone')),
      ).resolves.toEqual({ status: 404, message: SYSTEM_USER_NOT_FOUND });
      expect(txUpdate).not.toHaveBeenCalled();
    });

    it('403s a self-delete before any write (AC-48)', async () => {
      txFindFirst.mockResolvedValue({
        id: 'sa-1',
        role: SystemRole.SUPER_ADMIN,
      });

      await expect(
        service.softDelete(SUPER_ADMIN_ACTOR, 'sa-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(txUpdate).not.toHaveBeenCalled();
    });

    it('rejects deleting the last active SUPER_ADMIN with 409 and rolls back (AC-50)', async () => {
      txFindFirst.mockResolvedValue({
        id: 'sa-2',
        role: SystemRole.SUPER_ADMIN,
      });
      txCount.mockResolvedValue(0);

      await expect(
        captureHttpError(service.softDelete(SUPER_ADMIN_ACTOR, 'sa-2')),
      ).resolves.toEqual({ status: 409, message: LAST_SUPER_ADMIN });
    });

    it.each(['40001', '40P01'])(
      'maps a raw SQLSTATE %s to 409 (AC-51)',
      async (sqlstate) => {
        $transaction.mockRejectedValue(rawSqlstateError(sqlstate));

        await expect(
          service.softDelete(SUPER_ADMIN_ACTOR, 'sa-2'),
        ).rejects.toBeInstanceOf(ConflictException);
      },
    );
  });

  // ───────────────────────── restore ─────────────────────────

  describe('restore', () => {
    beforeEach(() => runInteractiveTx());

    it('is the ONE query that omits the deletedAt filter when resolving a target (AC-57)', async () => {
      txFindUnique.mockResolvedValue({ id: 'x', deletedAt: new Date() });
      txUpdate.mockResolvedValue(row);

      await service.restore('x');

      expect(txFindUnique).toHaveBeenCalledWith({
        where: { id: 'x' },
        select: { id: true, deletedAt: true },
      });
    });

    it('clears deletedAt and nothing else (AC-55)', async () => {
      txFindUnique.mockResolvedValue({ id: 'x', deletedAt: new Date() });
      txUpdate.mockResolvedValue(row);

      await service.restore('x');

      expect(txUpdate).toHaveBeenCalledWith({
        where: { id: 'x' },
        data: { deletedAt: null },
        select: PUBLIC_FIELDS,
      });
    });

    it('404s an unknown id (AC-56)', async () => {
      txFindUnique.mockResolvedValue(null);

      await expect(captureHttpError(service.restore('nope'))).resolves.toEqual({
        status: 404,
        message: SYSTEM_USER_NOT_FOUND,
      });
    });

    it('409s a live row (AC-56)', async () => {
      txFindUnique.mockResolvedValue({ id: 'x', deletedAt: null });

      await expect(captureHttpError(service.restore('x'))).resolves.toEqual({
        status: 409,
        message: USER_NOT_DELETED,
      });
      expect(txUpdate).not.toHaveBeenCalled();
    });

    it('needs no Serializable isolation, no invariant count, and no P2002 handling', async () => {
      txFindUnique.mockResolvedValue({ id: 'x', deletedAt: new Date() });
      txUpdate.mockResolvedValue(row);

      await service.restore('x');

      expect(txOptionsOf()).toBeUndefined();
      expect(txCount).not.toHaveBeenCalled();
    });
  });
});
