/**
 * Spec for `scripts/create-super-admin.ts`.
 *
 * WHY IT LIVES HERE AND NOT NEXT TO THE SCRIPT: the root jest config pins `rootDir: src`, so a spec
 * under `scripts/` is never discovered — it would silently never run, which is worse than no test.
 * The same reasoning (and the same placement) as `hash-password.script.spec.ts`.
 *
 * The readline masking itself is NOT tested — the prompt seam (`Prompter`) is mocked instead. What
 * is asserted is the security-relevant behaviour around it: the TTY gate, the length policy, the
 * confirm, the reserved flag, idempotency, and the `--force` update block.
 */
import { Logger } from '@nestjs/common';
import { Prisma, SystemRole, type PrismaClient } from '@prisma/client';
import {
  MIN_PASSWORD_LENGTH,
  NOT_A_SUPER_ADMIN_MESSAGE,
  RESERVED_DEPARTMENT_NAME,
  RESERVED_PERSONNEL_ROLE_NAME,
  assertInteractive,
  assertTargetIsSuperAdminOrAbsent,
  collectCredentials,
  createSuperAdmin,
  normalise,
  resolveOrCreateReservedDepartment,
  resolveOrCreateReservedPersonnelRole,
  validatePassword,
  type Credentials,
  type Prompter,
} from '../../scripts/create-super-admin';

// Silence the script's operator output. `Logger.prototype`, matching hash-password.script.spec.ts —
// mocking the whole '@nestjs/common' module would drag every exception class through an `any`.
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const VALID_PASSWORD = 'correct-horse-battery-staple';

const CREDENTIALS: Credentials = {
  email: 'root@easybook.local',
  password: VALID_PASSWORD,
  firstName: 'Ada',
  lastName: 'Lovelace',
};

/** A `PrismaClient` narrowed to what the script actually touches. */
const makePrisma = () => ({
  department: { findFirst: jest.fn(), create: jest.fn() },
  personnelRole: { findFirst: jest.fn(), create: jest.fn() },
  systemUser: { count: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
});

type MockPrisma = ReturnType<typeof makePrisma>;
const asClient = (p: MockPrisma): PrismaClient => p as unknown as PrismaClient;

describe('scripts/create-super-admin', () => {
  // ───────────────────────── the TTY gate (AC-B15) ─────────────────────────

  describe('assertInteractive', () => {
    it('AC-B15 — accepts a TTY', () => {
      expect(() => assertInteractive({ isTTY: true })).not.toThrow();
    });

    it('AC-B15 — REFUSES piped stdin, so `echo pw | npm run ...` cannot restore the .env bypass', () => {
      // "Interactive-only" is a security property, so it is enforced, not documented.
      expect(() => assertInteractive({ isTTY: false })).toThrow(/terminal/i);
      expect(() => assertInteractive({})).toThrow(/terminal/i);
    });
  });

  // ───────────────────────── validation (AC-B16) ─────────────────────────

  describe('validatePassword', () => {
    it(`AC-B16 — rejects fewer than ${MIN_PASSWORD_LENGTH} characters`, () => {
      expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toMatch(
        /at least 12 characters/,
      );
    });

    it('AC-B16 — accepts the threshold exactly', () => {
      expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    });

    it('AC-B16 — never echoes the password or its actual length in the message', () => {
      const secret = 'shortpw';
      const message = validatePassword(secret);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(String(secret.length));
    });
  });

  it('normalises the email exactly as normaliseEmail does (trim + lowercase)', () => {
    expect(normalise('  ROOT@EasyBook.Local ')).toBe('root@easybook.local');
  });

  // ───────────────────────── the prompts (AC-B15/B16) ─────────────────────────

  describe('collectCredentials', () => {
    /**
     * Scripts the prompt seam: plain answers in order, masked answers in order. The mocks are
     * returned alongside the `Prompter` so assertions reference them directly — reading
     * `prompter.askMasked` back off the object is an unbound method reference.
     */
    const prompterOf = (plain: string[], masked: string[]) => {
      const ask = jest.fn(() => Promise.resolve(plain.shift() ?? ''));
      const askMasked = jest.fn(() => Promise.resolve(masked.shift() ?? ''));
      const prompter: Prompter = { ask, askMasked, close: jest.fn() };
      return { prompter, ask, askMasked };
    };

    it('AC-B15 — prompts for exactly Email, Password, Confirm, First name, Last name', async () => {
      const { prompter, ask, askMasked } = prompterOf(
        ['root@easybook.local', 'Ada', 'Lovelace'],
        [VALID_PASSWORD, VALID_PASSWORD],
      );

      const result = await collectCredentials(prompter);

      expect(result).toEqual(CREDENTIALS);
      // The password is masked; everything else is not.
      expect(askMasked).toHaveBeenCalledTimes(2);
      expect(ask).toHaveBeenCalledTimes(3);
    });

    it('AC-B15 — NEVER prompts for Department or Position', async () => {
      const { prompter, ask } = prompterOf(
        ['root@easybook.local', 'Ada', 'Lovelace'],
        [VALID_PASSWORD, VALID_PASSWORD],
      );
      await collectCredentials(prompter);

      const asked = ask.mock.calls.flat().join(' ').toLowerCase();
      expect(asked).not.toMatch(/department|position|role/);
    });

    it('AC-B16 — a mismatched confirmation re-prompts rather than aborting', async () => {
      const { prompter, askMasked } = prompterOf(
        ['root@easybook.local', 'Ada', 'Lovelace'],
        [
          'first-attempt-typo',
          'first-attempt-TYPO',
          VALID_PASSWORD,
          VALID_PASSWORD,
        ],
      );

      const result = await collectCredentials(prompter);

      expect(result.password).toBe(VALID_PASSWORD);
      expect(askMasked).toHaveBeenCalledTimes(4);
    });

    it('AC-B16 — a too-short password re-prompts and never reaches the confirm', async () => {
      const { prompter, askMasked } = prompterOf(
        ['root@easybook.local', 'Ada', 'Lovelace'],
        ['short', VALID_PASSWORD, VALID_PASSWORD],
      );

      const result = await collectCredentials(prompter);

      expect(result.password).toBe(VALID_PASSWORD);
      // 'short' fails the length policy before a confirm is requested: 1 + 2, not 2 + 2.
      expect(askMasked).toHaveBeenCalledTimes(3);
    });

    it('caps re-prompts so a non-interactive edge case cannot spin forever', async () => {
      const { prompter } = prompterOf(['', '', '', ''], []);
      await expect(collectCredentials(prompter)).rejects.toThrow(
        /Too many invalid attempts/,
      );
    });

    it('trims the names it stores', async () => {
      const { prompter } = prompterOf(
        ['root@easybook.local', '  Ada  ', '  Lovelace  '],
        [VALID_PASSWORD, VALID_PASSWORD],
      );
      const result = await collectCredentials(prompter);
      expect(result.firstName).toBe('Ada');
      expect(result.lastName).toBe('Lovelace');
    });
  });

  // ─────────────── the reserved rows (AC-B11 / AC-B17) ───────────────

  describe('resolve-or-create the reserved options', () => {
    let prisma: MockPrisma;
    beforeEach(() => (prisma = makePrisma()));

    it('AC-B17 — creates the reserved DEPARTMENT with isSystemReserved: true', async () => {
      prisma.department.findFirst.mockResolvedValue(null);
      prisma.department.create.mockResolvedValue({ id: 11 });

      const id = await resolveOrCreateReservedDepartment(asClient(prisma));

      expect(id).toBe(11);
      expect(prisma.department.create).toHaveBeenCalledWith({
        data: { name: RESERVED_DEPARTMENT_NAME, isSystemReserved: true },
        select: { id: true },
      });
    });

    it('AC-B17 — creates the reserved PERSONNEL ROLE with isSystemReserved: true', async () => {
      prisma.personnelRole.findFirst.mockResolvedValue(null);
      prisma.personnelRole.create.mockResolvedValue({ id: 7 });

      const id = await resolveOrCreateReservedPersonnelRole(asClient(prisma));

      expect(id).toBe(7);
      expect(prisma.personnelRole.create).toHaveBeenCalledWith({
        data: { name: RESERVED_PERSONNEL_ROLE_NAME, isSystemReserved: true },
        select: { id: true },
      });
    });

    it('AC-B17 — a second run finds the existing row and creates NO duplicate', async () => {
      prisma.department.findFirst.mockResolvedValue({ id: 11 });

      const id = await resolveOrCreateReservedDepartment(asClient(prisma));

      expect(id).toBe(11);
      expect(prisma.department.create).not.toHaveBeenCalled();
    });

    it('probes on the FLAG, so an ordinary row of the same name is never adopted as reserved', async () => {
      // If an ADMIN somehow owns an active NON-reserved row of that name, adopting it would be a
      // privilege-relevant confusion. The probe filters isSystemReserved: true precisely to miss it.
      prisma.department.findFirst.mockResolvedValue(null);
      prisma.department.create.mockResolvedValue({ id: 11 });

      await resolveOrCreateReservedDepartment(asClient(prisma));

      expect(prisma.department.findFirst).toHaveBeenCalledWith({
        where: {
          name: RESERVED_DEPARTMENT_NAME,
          deletedAt: null,
          isSystemReserved: true,
        },
        select: { id: true },
      });
    });

    it('translates the partial-index P2002 into an actionable operator message', async () => {
      prisma.department.findFirst.mockResolvedValue(null);
      prisma.department.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '7.8.0',
        }),
      );

      await expect(
        resolveOrCreateReservedDepartment(asClient(prisma)),
      ).rejects.toThrow(/ordinary \(non-reserved\) department option named/);
    });
  });

  // ─────────────── the --force refusal (AC-B18) ───────────────

  describe('assertTargetIsSuperAdminOrAbsent', () => {
    let prisma: MockPrisma;
    beforeEach(() => (prisma = makePrisma()));

    it('AC-B18 — refuses when the email belongs to an existing ADMIN', async () => {
      prisma.systemUser.findUnique.mockResolvedValue({
        role: SystemRole.ADMIN,
      });

      await expect(
        assertTargetIsSuperAdminOrAbsent(
          asClient(prisma),
          'admin@easybook.local',
        ),
      ).rejects.toThrow(NOT_A_SUPER_ADMIN_MESSAGE);
    });

    it('AC-B18 — refuses an existing STAFF too', async () => {
      prisma.systemUser.findUnique.mockResolvedValue({
        role: SystemRole.STAFF,
      });
      await expect(
        assertTargetIsSuperAdminOrAbsent(asClient(prisma), 'x@y.local'),
      ).rejects.toThrow(NOT_A_SUPER_ADMIN_MESSAGE);
    });

    it('AC-B18 — allows an absent address', async () => {
      prisma.systemUser.findUnique.mockResolvedValue(null);
      await expect(
        assertTargetIsSuperAdminOrAbsent(asClient(prisma), 'new@y.local'),
      ).resolves.toBeUndefined();
    });

    it('AC-B18 — allows an existing SUPER_ADMIN (the break-glass case)', async () => {
      prisma.systemUser.findUnique.mockResolvedValue({
        role: SystemRole.SUPER_ADMIN,
      });
      await expect(
        assertTargetIsSuperAdminOrAbsent(asClient(prisma), 'root@y.local'),
      ).resolves.toBeUndefined();
    });
  });

  // ─────────────── createSuperAdmin (AC-B17 / AC-B18) ───────────────

  describe('createSuperAdmin', () => {
    let prisma: MockPrisma;

    beforeEach(() => {
      prisma = makePrisma();
      prisma.department.findFirst.mockResolvedValue({ id: 11 });
      prisma.personnelRole.findFirst.mockResolvedValue({ id: 7 });
      prisma.systemUser.findUnique.mockResolvedValue(null);
      prisma.systemUser.upsert.mockResolvedValue({
        id: 'sa-1',
        email: CREDENTIALS.email,
      });
    });

    it('AC-B17 — on a fresh DB, creates the SUPER_ADMIN against BOTH reserved rows', async () => {
      prisma.systemUser.count.mockResolvedValue(0);

      const result = await createSuperAdmin(asClient(prisma), CREDENTIALS, {
        force: false,
      });

      expect(result).toEqual({
        id: 'sa-1',
        email: CREDENTIALS.email,
        reset: false,
      });
      const [args] = prisma.systemUser.upsert.mock.calls[0] as [
        { create: Record<string, unknown> },
      ];
      expect(args.create).toMatchObject({
        email: CREDENTIALS.email,
        role: SystemRole.SUPER_ADMIN,
        departmentId: 11,
        personnelRoleId: 7,
        mustChangePassword: false,
        isActive: true,
        createdById: null,
      });
    });

    it('AC-B16 — stores only the digest; the plaintext never reaches a column', async () => {
      prisma.systemUser.count.mockResolvedValue(0);
      await createSuperAdmin(asClient(prisma), CREDENTIALS, { force: false });

      const [args] = prisma.systemUser.upsert.mock.calls[0] as [
        { create: Record<string, unknown>; update: Record<string, unknown> },
      ];
      expect(args.create.passwordHash).toMatch(/^\$argon2id\$/);
      expect(JSON.stringify(args)).not.toContain(VALID_PASSWORD);
    });

    it('AC-B17 — refuses (exit 0, no writes) when an active SUPER_ADMIN exists and --force is absent', async () => {
      prisma.systemUser.count.mockResolvedValue(1);

      const result = await createSuperAdmin(asClient(prisma), CREDENTIALS, {
        force: false,
      });

      expect(result).toBeNull(); // idempotent, non-error
      expect(prisma.systemUser.upsert).not.toHaveBeenCalled();
      expect(prisma.department.create).not.toHaveBeenCalled();
    });

    it('AC-B17 — the existence count ignores soft-deleted SUPER_ADMINs but NOT suspended ones', async () => {
      prisma.systemUser.count.mockResolvedValue(0);
      await createSuperAdmin(asClient(prisma), CREDENTIALS, { force: false });

      // No `isActive` filter: a suspended super admin is one flag-flip from working, so the script
      // must refuse rather than mint a second one. A soft-deleted one grants nobody access.
      expect(prisma.systemUser.count).toHaveBeenCalledWith({
        where: { role: SystemRole.SUPER_ADMIN, deletedAt: null },
      });
    });

    it('AC-B18 — --force sets EXACTLY the six documented fields, and not role or lineUserId', async () => {
      prisma.systemUser.count.mockResolvedValue(1);

      const result = await createSuperAdmin(asClient(prisma), CREDENTIALS, {
        force: true,
      });

      expect(result?.reset).toBe(true);
      const [args] = prisma.systemUser.upsert.mock.calls[0] as [
        { where: unknown; update: Record<string, unknown> },
      ];
      expect(Object.keys(args.update).sort()).toEqual([
        'deletedAt',
        'departmentId',
        'isActive',
        'mustChangePassword',
        'passwordHash',
        'personnelRoleId',
      ]);
      expect(args.update).toMatchObject({
        departmentId: 11,
        personnelRoleId: 7,
        mustChangePassword: false,
        isActive: true,
        deletedAt: null,
      });
      // The reversal must not drag a promotion or a notification address along with it.
      expect(args.update.role).toBeUndefined();
      expect(args.update.lineUserId).toBeUndefined();
    });

    it('AC-B18 — upserts on email, so the SAME row returns and no second row is created', async () => {
      prisma.systemUser.count.mockResolvedValue(1);
      await createSuperAdmin(asClient(prisma), CREDENTIALS, { force: true });

      const [args] = prisma.systemUser.upsert.mock.calls[0] as [
        { where: { email: string } },
      ];
      expect(args.where).toEqual({ email: CREDENTIALS.email });
      expect(prisma.systemUser.upsert).toHaveBeenCalledTimes(1);
    });

    it('AC-B18 — --force still refuses a non-SUPER_ADMIN target and writes nothing', async () => {
      prisma.systemUser.count.mockResolvedValue(1);
      prisma.systemUser.findUnique.mockResolvedValue({
        role: SystemRole.ADMIN,
      });

      await expect(
        createSuperAdmin(asClient(prisma), CREDENTIALS, { force: true }),
      ).rejects.toThrow(NOT_A_SUPER_ADMIN_MESSAGE);
      expect(prisma.systemUser.upsert).not.toHaveBeenCalled();
    });
  });
});
