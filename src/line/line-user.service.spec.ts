import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppAccess, Prisma, SystemRole } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AdminUpdateLineUserRegistrationDto } from './dto/admin-update-line-user-registration.dto';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { UpdateLineUserRegistrationDto } from './dto/update-line-user-registration.dto';
import { LineService } from './line.service';
// Asserted against the shared constant, not a restated literal: these fixtures
// silently went stale when the TYPE_1 artwork changed from 2500x843 to 2500x1686.
import { RICH_MENU_SPECS } from './rich-menu.constants';
import {
  ACCESS_NOTIFICATION_MESSAGES,
  accessToRichMenuType,
  buildRejectionMessage,
  LINE_USER_PUBLIC_FIELDS,
  LineUserService,
} from './line-user.service';
import {
  ALREADY_REGISTERED,
  CANNOT_REJECT_UNREGISTERED,
  INVALID_DEPARTMENT,
  INVALID_PERSONNEL_ROLE,
  LINE_USER_ACCESS_TRANSITION_FORBIDDEN,
  LINE_USER_NOT_FOUND,
  LINE_USER_REGISTRATION_NOT_FOUND,
  REGISTRATION_NOT_EDITABLE,
  REJECTION_REASON_REQUIRED,
} from './line-users.errors';

interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/** A mock interactive-transaction client, mirroring the fields `register` touches. */
const makeTx = () => ({
  lineUser: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  lineUserRegistration: {
    create: jest.fn(),
  },
  department: { findFirst: jest.fn() },
  personnelRole: { findFirst: jest.fn() },
});

const VALID_DTO: CreateLineUserRegistrationDto = {
  firstName: 'Somchai',
  lastName: 'Jaidee',
  phone: '081-234-5678',
  departmentId: 1,
  personnelRoleId: 2,
};

/** Owner-facing registration row (matches REGISTRATION_OWNER_SELECT: ids + resolved option names). */
const OWNER_REGISTRATION_ROW = {
  id: 'reg-1',
  firstName: 'Somchai',
  lastName: 'Jaidee',
  phone: '081-234-5678',
  departmentId: 1,
  personnelRoleId: 2,
  department: { name: 'Computer Science' },
  personnelRole: { name: 'Teacher' },
  createdAt: new Date('2026-07-14T10:00:00.000Z'),
  updatedAt: new Date('2026-07-14T10:00:00.000Z'),
};

describe('LineUserService', () => {
  let service: LineUserService;
  const lineUser = {
    upsert: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  };
  const lineUserRegistration = {
    findFirst: jest.fn(),
    update: jest.fn(),
  };
  const department = { findFirst: jest.fn(), findMany: jest.fn() };
  const personnelRole = { findFirst: jest.fn(), findMany: jest.fn() };
  const $transaction = jest.fn();
  const line = {
    findRichMenuId: jest.fn(),
    linkRichMenuToUser: jest.fn(),
    push: jest.fn(),
  };
  // The gateway is a three-method mock, the same shape `LineService` already has. Its methods are
  // synchronous and `void` in production, so nothing here needs to resolve.
  const realtime = {
    emitLineUserCreated: jest.fn(),
    emitLineUserUpdated: jest.fn(),
    emitLineUserDeleted: jest.fn(),
  };

  // The push copy per target access, read from the service's own source of truth so these
  // assertions test ROUTING (which copy goes out for which transition), not the copy's spelling.
  const ALLOWED_MSG = ACCESS_NOTIFICATION_MESSAGES.ALLOWED!;
  const BLOCKED_MSG = ACCESS_NOTIFICATION_MESSAGES.BLOCKED!;
  const PENDING_MSG = ACCESS_NOTIFICATION_MESSAGES.PENDING!;

  // The exact reject copy `notifyRejection` sends ({reason} interpolated) — same builder, so a
  // change to the template stays covered by the reason-interpolation assertions instead of a diff.
  const rejectMsg = (reason: string) => buildRejectionMessage(reason);

  const publicRow = {
    id: 'lu-1',
    lineUserId: 'U123',
    displayName: 'Alice',
    pictureUrl: null,
    statusMessage: null,
    richMenuType: 'TYPE_1',
    access: AppAccess.PENDING,
    followedAt: new Date('2026-07-07T10:00:00.000Z'),
    registration: null,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LineUserService,
        {
          provide: PrismaService,
          useValue: {
            lineUser,
            lineUserRegistration,
            department,
            personnelRole,
            $transaction,
          },
        },
        { provide: LineService, useValue: line },
        { provide: RealtimeGateway, useValue: realtime },
      ],
    }).compile();
    service = module.get<LineUserService>(LineUserService);
  });

  it('upserts on follow: create by lineUserId, restore (deletedAt=null) on update', async () => {
    lineUser.upsert.mockResolvedValue({ id: '1' });
    lineUser.findFirst.mockResolvedValue(null); // publish() re-read: no event, not the point here
    await service.upsertOnFollow({
      lineUserId: 'U123',
      displayName: 'Alice',
    });

    const [arg] = lineUser.upsert.mock.calls[0] as [
      {
        where: Record<string, unknown>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      },
    ];
    expect(arg.where).toEqual({ lineUserId: 'U123' });
    expect(arg.create.lineUserId).toBe('U123');
    expect(arg.create.displayName).toBe('Alice');
    expect(arg.update.deletedAt).toBeNull();
    expect(arg.update.followedAt).toBeInstanceOf(Date);
    // permission/richMenuType are NOT reset on re-follow
    expect(arg.update).not.toHaveProperty('access');
    expect(arg.update).not.toHaveProperty('richMenuType');
  });

  // The unfollow path was reworked from `updateMany` (count only) to a lookup + update, because the
  // `lineUser.deleted` payload needs the cuid. The `{ count }` return contract is UNCHANGED, so
  // `LineWebhookService` needs no edit — asserted below.
  it('soft-deletes only active rows for the given lineUserId', async () => {
    lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
    lineUser.update.mockResolvedValue({ id: 'lu-1' });

    await expect(service.softDeleteByLineUserId('U123')).resolves.toEqual({
      count: 1,
    });

    const [lookup] = lineUser.findFirst.mock.calls[0] as [
      { where: Record<string, unknown>; select: Record<string, unknown> },
    ];
    expect(lookup.where).toEqual({ lineUserId: 'U123', deletedAt: null });

    const [arg] = lineUser.update.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(arg.where).toEqual({ id: 'lu-1' });
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
  });

  it('unfollow emits lineUser.deleted with the CUID, not the LINE-side U… id', async () => {
    lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
    lineUser.update.mockResolvedValue({ id: 'lu-1' });

    await service.softDeleteByLineUserId('U123');

    expect(realtime.emitLineUserDeleted).toHaveBeenCalledTimes(1);
    expect(realtime.emitLineUserDeleted).toHaveBeenCalledWith('lu-1');
  });

  it('unfollow of an absent/already-deleted row writes nothing and emits nothing', async () => {
    lineUser.findFirst.mockResolvedValue(null);

    await expect(service.softDeleteByLineUserId('U404')).resolves.toEqual({
      count: 0,
    });

    expect(lineUser.update).not.toHaveBeenCalled();
    expect(realtime.emitLineUserDeleted).not.toHaveBeenCalled();
  });

  it('finds only active users', async () => {
    lineUser.findFirst.mockResolvedValue(null);
    await service.findActiveByLineUserId('U123');
    expect(lineUser.findFirst).toHaveBeenCalledWith({
      where: { lineUserId: 'U123', deletedAt: null },
    });
  });

  // ───────────────────────── getOrCreateByLineUserId ─────────────────────────

  describe('getOrCreateByLineUserId', () => {
    it('returns the existing active row without creating', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1', access: 'PENDING' });
      const result = await service.getOrCreateByLineUserId('U123');
      expect(result).toEqual({ id: 'lu-1', access: 'PENDING' });
      expect(lineUser.create).not.toHaveBeenCalled();
    });

    it('creates a fresh UNREGISTERED row when none exists', async () => {
      lineUser.findFirst.mockResolvedValue(null);
      lineUser.create.mockResolvedValue({
        id: 'lu-2',
        access: AppAccess.UNREGISTERED,
      });
      const result = await service.getOrCreateByLineUserId('U999');
      expect(lineUser.create).toHaveBeenCalledWith({
        data: { lineUserId: 'U999' },
      });
      expect(result.access).toBe(AppAccess.UNREGISTERED);
    });
  });

  // ───────────────────────── setRichMenuType / applyRichMenu ─────────────────────────

  it('setRichMenuType returns null when the user is not active', async () => {
    lineUser.findFirst.mockResolvedValue(null);
    expect(await service.setRichMenuType('U123', 'TYPE_2')).toBeNull();
    expect(lineUser.update).not.toHaveBeenCalled();
  });

  it('setRichMenuType updates the active user', async () => {
    lineUser.findFirst.mockResolvedValue({ id: '1', richMenuType: 'TYPE_1' });
    lineUser.update.mockResolvedValue({ id: '1', richMenuType: 'TYPE_2' });
    await service.setRichMenuType('U123', 'TYPE_2');
    expect(lineUser.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { richMenuType: 'TYPE_2' },
    });
  });

  it('applyRichMenu resolves the menu by name+size and links it', async () => {
    line.findRichMenuId.mockResolvedValue('rm-123');
    await service.applyRichMenu({
      lineUserId: 'U123',
      richMenuType: 'TYPE_2',
    });
    expect(line.findRichMenuId).toHaveBeenCalledWith(RICH_MENU_SPECS.TYPE_2);
    expect(line.linkRichMenuToUser).toHaveBeenCalledWith('U123', 'rm-123');
  });

  it('applyRichMenu throws when the menu is missing on LINE', async () => {
    line.findRichMenuId.mockResolvedValue(null);
    await expect(
      service.applyRichMenu({
        lineUserId: 'U123',
        richMenuType: 'TYPE_1',
      }),
    ).rejects.toThrow(/not found on LINE/);
    expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
  });

  it('accessToRichMenuType maps ALLOWED->TYPE_2 and everything else->TYPE_1', () => {
    expect(accessToRichMenuType(AppAccess.ALLOWED)).toBe('TYPE_2');
    expect(accessToRichMenuType(AppAccess.UNREGISTERED)).toBe('TYPE_1');
    expect(accessToRichMenuType(AppAccess.PENDING)).toBe('TYPE_1');
    expect(accessToRichMenuType(AppAccess.BLOCKED)).toBe('TYPE_1');
  });

  // ───────────────────────── getRegistrationOptions ─────────────────────────

  describe('getRegistrationOptions', () => {
    it('returns non-deleted departments + personnel roles, id+name, ordered name ASC (SC-B7)', async () => {
      department.findMany.mockResolvedValue([{ id: 1, name: 'Biology' }]);
      personnelRole.findMany.mockResolvedValue([{ id: 2, name: 'Teacher' }]);

      const result = await service.getRegistrationOptions();

      expect(department.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null, isSystemReserved: false },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      expect(personnelRole.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null, isSystemReserved: false },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      expect(result).toEqual({
        departments: [{ id: 1, name: 'Biology' }],
        personnelRoles: [{ id: 2, name: 'Teacher' }],
      });
    });

    it('AC-B3 — the reserved filter is HARDCODED: no parameter can widen it for a LINE caller', async () => {
      // This surface has no actor and no SystemRole to branch on, so there is nothing to widen and
      // no role check belongs here. A LINE end user can never see a reserved option.
      department.findMany.mockResolvedValue([]);
      personnelRole.findMany.mockResolvedValue([]);

      await service.getRegistrationOptions();

      for (const delegate of [department.findMany, personnelRole.findMany]) {
        const [args] = delegate.mock.calls[0] as [
          { where: { isSystemReserved: boolean } },
        ];
        expect(args.where.isSystemReserved).toBe(false);
      }
    });
  });

  // ───────────────────────── register ─────────────────────────

  describe('register', () => {
    const primeTx = () => {
      const tx = makeTx();
      tx.department.findFirst.mockResolvedValue({ id: 1 });
      tx.personnelRole.findFirst.mockResolvedValue({ id: 2 });
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );
      return tx;
    };

    it('creates the registration and flips UNREGISTERED->PENDING, returning the status view (AC-B3)', async () => {
      const tx = primeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.lineUserRegistration.create.mockResolvedValue(OWNER_REGISTRATION_ROW);
      tx.lineUser.update.mockResolvedValue({ access: AppAccess.PENDING });

      const result = await service.register('U123', VALID_DTO);

      expect(tx.lineUserRegistration.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // `phoneDigits` is NOT in the DTO — it is derived on write, so it is the one field
          // a spread of the caller's payload can never account for. Asserted by value.
          data: {
            lineUserId: 'lu-1',
            ...VALID_DTO,
            phoneDigits: '0812345678',
          },
        }),
      );
      expect(tx.lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: { access: AppAccess.PENDING },
        select: { access: true },
      });
      expect(result.access).toBe(AppAccess.PENDING);
      expect(result.registration).toMatchObject({
        id: 'reg-1',
        phone: '081-234-5678',
        departmentId: 1,
        department: 'Computer Science',
        personnelRoleId: 2,
        personnelRole: 'Teacher',
        createdAt: '2026-07-14T10:00:00.000Z',
      });
      // Best-effort "registration received" push (PENDING copy) to the caller's U… id (the arg),
      // not the cuid. Reuses the single PENDING source, so it can't drift from updateAccess.
      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: PENDING_MSG },
      ]);
    });

    it('rejects a deleted/unknown departmentId with 400 (SC-B6), writing nothing', async () => {
      const tx = makeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.department.findFirst.mockResolvedValue(null);
      tx.personnelRole.findFirst.mockResolvedValue({ id: 2 });
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );

      await expect(service.register('U123', VALID_DTO)).rejects.toThrow(
        new BadRequestException(INVALID_DEPARTMENT),
      );
      expect(tx.lineUserRegistration.create).not.toHaveBeenCalled();
    });

    it('AC-B7 — a system-reserved option is unassignable and 400s exactly like an unknown id', async () => {
      const tx = makeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      // The reserved predicate rides in the same WHERE, so a reserved row simply does not match —
      // the caller cannot distinguish it from a nonexistent one. Never a 403 (existence oracle).
      tx.department.findFirst.mockResolvedValue(null);
      tx.personnelRole.findFirst.mockResolvedValue({ id: 2 });
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );

      await expect(service.register('U123', VALID_DTO)).rejects.toThrow(
        new BadRequestException(INVALID_DEPARTMENT),
      );
      expect(tx.department.findFirst).toHaveBeenCalledWith({
        where: {
          id: VALID_DTO.departmentId,
          deletedAt: null,
          isSystemReserved: false,
        },
        select: { id: true },
      });
      expect(tx.lineUserRegistration.create).not.toHaveBeenCalled();
    });

    it('rejects a deleted/unknown personnelRoleId with 400 (SC-B6)', async () => {
      const tx = makeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.department.findFirst.mockResolvedValue({ id: 1 });
      tx.personnelRole.findFirst.mockResolvedValue(null);
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );

      await expect(service.register('U123', VALID_DTO)).rejects.toThrow(
        new BadRequestException(INVALID_PERSONNEL_ROLE),
      );
      expect(tx.lineUserRegistration.create).not.toHaveBeenCalled();
    });

    it('best-effort: register still resolves + persists when the push rejects (logged, not thrown)', async () => {
      const tx = primeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.lineUserRegistration.create.mockResolvedValue(OWNER_REGISTRATION_ROW);
      tx.lineUser.update.mockResolvedValue({ access: AppAccess.PENDING });
      line.push.mockRejectedValue(new Error('user blocked the bot'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const result = await service.register('U123', VALID_DTO);

      // The registration was committed and PENDING returned, despite the push failure.
      expect(result.access).toBe(AppAccess.PENDING);
      expect(tx.lineUserRegistration.create).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('creates the LineUser row when the caller opened the LIFF first (no prior follow)', async () => {
      const tx = primeTx();
      tx.lineUser.findFirst.mockResolvedValue(null);
      tx.lineUser.create.mockResolvedValue({
        id: 'lu-new',
        access: AppAccess.UNREGISTERED,
      });
      tx.lineUserRegistration.create.mockResolvedValue({
        ...OWNER_REGISTRATION_ROW,
      });
      tx.lineUser.update.mockResolvedValue({ access: AppAccess.PENDING });

      await service.register('U-new', VALID_DTO);

      expect(tx.lineUser.create).toHaveBeenCalledWith({
        data: { lineUserId: 'U-new' },
        select: { id: true, access: true },
      });
    });

    it('409s when the user is not UNREGISTERED (AC-B5)', async () => {
      const tx = makeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );

      await expect(service.register('U123', VALID_DTO)).rejects.toThrow(
        new ConflictException(ALREADY_REGISTERED),
      );
      expect(tx.lineUserRegistration.create).not.toHaveBeenCalled();
    });

    it('maps a P2002 on lineUserId (a race) to a 409 ALREADY_REGISTERED (AC-B2)', async () => {
      const tx = primeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.lineUserRegistration.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
          meta: { target: ['lineUserId'] },
        }),
      );

      await expect(service.register('U123', VALID_DTO)).rejects.toThrow(
        new ConflictException(ALREADY_REGISTERED),
      );
    });
  });

  // ───────────────────────── updateRegistration (PENDING/REJECTED self-edit) ─────────────────────────

  describe('updateRegistration', () => {
    const EDIT_DTO: UpdateLineUserRegistrationDto = { ...VALID_DTO };

    // The self-edit now wraps assertActiveOptions + the registration update (+ the REJECTED→PENDING
    // access flip) in one $transaction. The tx client IS the same set of delegate mocks, so all
    // existing per-delegate assertions still hold.
    const primeTx = () =>
      $transaction.mockImplementation((cb: (client: unknown) => unknown) =>
        cb({ lineUser, lineUserRegistration, department, personnelRole }),
      );

    it('updates all fields for a PENDING caller, keeps PENDING, and sends NO push (SC-B8)', async () => {
      primeTx();
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });
      department.findFirst.mockResolvedValue({ id: 1 });
      personnelRole.findFirst.mockResolvedValue({ id: 2 });
      lineUserRegistration.update.mockResolvedValue(OWNER_REGISTRATION_ROW);

      const result = await service.updateRegistration('U123', EDIT_DTO);

      expect(lineUserRegistration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lineUserId: 'lu-1' },
          data: {
            firstName: 'Somchai',
            lastName: 'Jaidee',
            phone: '081-234-5678',
            phoneDigits: '0812345678',
            departmentId: 1,
            personnelRoleId: 2,
          },
        }),
      );
      expect(result.access).toBe(AppAccess.PENDING);
      expect(result.rejectionReason).toBeNull();
      expect(result.registration).toMatchObject({
        department: 'Computer Science',
        personnelRole: 'Teacher',
      });
      // A PENDING edit performs NO LineUser access write and NO push (Q6).
      expect(lineUser.update).not.toHaveBeenCalled();
      expect(line.push).not.toHaveBeenCalled();
    });

    it('a REJECTED caller resubmits: registration updated, access → PENDING, reason cleared, PENDING ack sent (AC-7)', async () => {
      primeTx();
      line.push.mockResolvedValue(undefined);
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.REJECTED,
      });
      department.findFirst.mockResolvedValue({ id: 1 });
      personnelRole.findFirst.mockResolvedValue({ id: 2 });
      lineUserRegistration.update.mockResolvedValue(OWNER_REGISTRATION_ROW);
      lineUser.update.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });

      const result = await service.updateRegistration('U123', EDIT_DTO);

      expect(lineUserRegistration.update).toHaveBeenCalled();
      // access flipped REJECTED → PENDING and rejectionReason cleared, in the same flow.
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: { access: AppAccess.PENDING, rejectionReason: null },
      });
      // Returns the status DTO with PENDING + null reason (invariant holds after leaving REJECTED).
      expect(result.access).toBe(AppAccess.PENDING);
      expect(result.rejectionReason).toBeNull();
      // The existing PENDING ack is pushed to the caller's verified U… id (not the cuid).
      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: PENDING_MSG },
      ]);
    });

    it('a REJECTED resubmit is fail-soft: still 200/PENDING when the PENDING ack push rejects (AC-7/AC-6)', async () => {
      primeTx();
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.REJECTED,
      });
      department.findFirst.mockResolvedValue({ id: 1 });
      personnelRole.findFirst.mockResolvedValue({ id: 2 });
      lineUserRegistration.update.mockResolvedValue(OWNER_REGISTRATION_ROW);
      lineUser.update.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });
      line.push.mockRejectedValue(new Error('user blocked the bot'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const result = await service.updateRegistration('U123', EDIT_DTO);

      // The resubmit committed (access → PENDING) despite the push failure.
      expect(result.access).toBe(AppAccess.PENDING);
      expect(result.rejectionReason).toBeNull();
      expect(lineUser.update).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it.each([AppAccess.ALLOWED, AppAccess.BLOCKED, AppAccess.UNREGISTERED])(
      '403s a non-editable caller (%s) with no write (SC-B9) — REJECTED is NO LONGER in this set',
      async (access) => {
        lineUser.findFirst.mockResolvedValue({ id: 'lu-1', access });

        await expect(
          service.updateRegistration('U123', EDIT_DTO),
        ).rejects.toThrow(new ForbiddenException(REGISTRATION_NOT_EDITABLE));
        expect(lineUserRegistration.update).not.toHaveBeenCalled();
      },
    );

    it('does NOT 403 a REJECTED caller — REJECTED is now an editable (resubmit) state', async () => {
      primeTx();
      line.push.mockResolvedValue(undefined);
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.REJECTED,
      });
      department.findFirst.mockResolvedValue({ id: 1 });
      personnelRole.findFirst.mockResolvedValue({ id: 2 });
      lineUserRegistration.update.mockResolvedValue(OWNER_REGISTRATION_ROW);
      lineUser.update.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });

      await expect(
        service.updateRegistration('U123', EDIT_DTO),
      ).resolves.toMatchObject({ access: AppAccess.PENDING });
    });

    it('403s when the caller has no active LineUser row (SC-B9)', async () => {
      lineUser.findFirst.mockResolvedValue(null);

      await expect(
        service.updateRegistration('U123', EDIT_DTO),
      ).rejects.toThrow(new ForbiddenException(REGISTRATION_NOT_EDITABLE));
      expect(lineUserRegistration.update).not.toHaveBeenCalled();
    });

    it('rejects a deleted/unknown option id with 400 and no write (SC-B10)', async () => {
      primeTx();
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });
      department.findFirst.mockResolvedValue(null);
      personnelRole.findFirst.mockResolvedValue({ id: 2 });

      await expect(
        service.updateRegistration('U123', EDIT_DTO),
      ).rejects.toThrow(new BadRequestException(INVALID_DEPARTMENT));
      expect(lineUserRegistration.update).not.toHaveBeenCalled();
    });

    it('AC-B7 — PATCH /registration also filters reserved options out of the assignability check', async () => {
      primeTx();
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });
      department.findFirst.mockResolvedValue(null);
      personnelRole.findFirst.mockResolvedValue({ id: 2 });

      await expect(
        service.updateRegistration('U123', EDIT_DTO),
      ).rejects.toThrow(new BadRequestException(INVALID_DEPARTMENT));
      expect(department.findFirst).toHaveBeenCalledWith({
        where: {
          id: EDIT_DTO.departmentId,
          deletedAt: null,
          isSystemReserved: false,
        },
        select: { id: true },
      });
    });
  });

  // ───────────────────────── getStatus ─────────────────────────

  describe('getStatus', () => {
    it('returns access + registration (with resolved option names) + null reason for a PENDING user', async () => {
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
        rejectionReason: null,
      });
      lineUserRegistration.findFirst.mockResolvedValue(OWNER_REGISTRATION_ROW);

      const result = await service.getStatus('U123');

      expect(lineUserRegistration.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lineUserId: 'lu-1', deletedAt: null },
        }),
      );
      expect(result.access).toBe(AppAccess.PENDING);
      expect(result.rejectionReason).toBeNull();
      expect(result.registration?.department).toBe('Computer Science');
      expect(result.registration?.personnelRole).toBe('Teacher');
    });

    it('surfaces access REJECTED + the stored rejectionReason (feeds the LIFF RejectedScreen)', async () => {
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.REJECTED,
        rejectionReason: 'เบอร์โทรศัพท์ไม่ถูกต้อง',
      });
      lineUserRegistration.findFirst.mockResolvedValue(OWNER_REGISTRATION_ROW);

      const result = await service.getStatus('U123');

      expect(result.access).toBe(AppAccess.REJECTED);
      expect(result.rejectionReason).toBe('เบอร์โทรศัพท์ไม่ถูกต้อง');
    });

    it('gives a LIFF-first caller a fresh UNREGISTERED state + null registration + null reason', async () => {
      lineUser.findFirst.mockResolvedValue(null);
      lineUser.create.mockResolvedValue({
        id: 'lu-new',
        access: AppAccess.UNREGISTERED,
        rejectionReason: null,
      });
      lineUserRegistration.findFirst.mockResolvedValue(null);

      const result = await service.getStatus('U-fresh');

      expect(result.access).toBe(AppAccess.UNREGISTERED);
      expect(result.registration).toBeNull();
      expect(result.rejectionReason).toBeNull();
    });
  });

  // ───────────────────────── findManyPaginated ─────────────────────────

  describe('findManyPaginated', () => {
    const optionsOf = (callIndex = 0): TxOptions | undefined =>
      (
        $transaction.mock.calls[callIndex] as [unknown[], TxOptions | undefined]
      )[1];

    it('filters deletedAt: null in both data and count, uses the DTO select, orders + paginates, and runs at RepeatableRead (AC-B2/B6)', async () => {
      $transaction.mockResolvedValue([[publicRow], 1]);

      const result = await service.findManyPaginated({ page: 2, limit: 20 });

      const [operations, options] = $transaction.mock.calls[0] as [
        unknown[],
        TxOptions,
      ];
      expect(operations).toHaveLength(2);
      expect(options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      expect(lineUser.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        select: LINE_USER_PUBLIC_FIELDS,
        orderBy: [{ followedAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 20,
      });
      expect(lineUser.count).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
      expect(result.data[0]).toEqual({
        id: 'lu-1',
        lineUserId: 'U123',
        displayName: 'Alice',
        pictureUrl: null,
        statusMessage: null,
        richMenuType: 'TYPE_1',
        access: AppAccess.PENDING,
        followedAt: '2026-07-07T10:00:00.000Z',
        registration: null,
      });
      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it('maps a nested registration relation into the compact summary with option ids + resolved names (AC-B11/SC-B5/§B-8a)', async () => {
      $transaction.mockResolvedValue([
        [
          {
            ...publicRow,
            access: AppAccess.ALLOWED,
            registration: {
              firstName: 'Somchai',
              lastName: 'Jaidee',
              phone: '081-234-5678',
              departmentId: 1,
              personnelRoleId: 2,
              department: { name: 'Computer Science' },
              personnelRole: { name: 'Teacher' },
              createdAt: new Date('2026-07-09T04:30:00.000Z'),
            },
          },
        ],
        1,
      ]);

      const result = await service.findManyPaginated({ page: 1, limit: 20 });

      // §B-8a additive contract: the summary now carries departmentId + personnelRoleId so the admin
      // edit modal can pre-select its dropdowns without a second fetch.
      expect(result.data[0].registration).toEqual({
        firstName: 'Somchai',
        lastName: 'Jaidee',
        phone: '081-234-5678',
        departmentId: 1,
        department: 'Computer Science',
        personnelRoleId: 2,
        personnelRole: 'Teacher',
        // Serialised from the registration's own createdAt — NOT `followedAt`, which this fixture
        // deliberately sets to a different day (2026-07-07) so the two cannot be confused.
        createdAt: '2026-07-09T04:30:00.000Z',
      });
    });

    it('§B-8a — LINE_USER_PUBLIC_FIELDS selects both option ids on the nested registration', () => {
      // The additive contract is only satisfiable if the select actually asks for the ids.
      expect(LINE_USER_PUBLIC_FIELDS.registration.select).toMatchObject({
        departmentId: true,
        personnelRoleId: true,
      });
    });

    it('adds a case-insensitive displayName contains when search is a non-empty trimmed string (AC-B4)', async () => {
      $transaction.mockResolvedValue([[], 0]);

      await service.findManyPaginated({ page: 1, limit: 20, search: '  ali ' });

      expect(lineUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            displayName: { contains: 'ali', mode: 'insensitive' },
          },
        }),
      );
    });

    it('omits the name filter when search is only whitespace', async () => {
      $transaction.mockResolvedValue([[], 0]);

      await service.findManyPaginated({ page: 1, limit: 20, search: '   ' });

      expect(lineUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } }),
      );
    });

    it('spreads the access filter into the where clause when provided (AC-B5)', async () => {
      $transaction.mockResolvedValue([[], 0]);

      await service.findManyPaginated({
        page: 1,
        limit: 20,
        access: AppAccess.BLOCKED,
      });

      expect(lineUser.count).toHaveBeenCalledWith({
        where: { deletedAt: null, access: AppAccess.BLOCKED },
      });
    });

    it('reports totalPages 0 for an empty result and never 404s a page past the end (AC-B3)', async () => {
      $transaction.mockResolvedValue([[], 0]);

      const result = await service.findManyPaginated({ page: 999, limit: 20 });

      expect(result.data).toEqual([]);
      expect(result.meta).toEqual({
        page: 999,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(optionsOf()).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });
  });

  // ───────────────────────── updateAccess ─────────────────────────

  describe('updateAccess', () => {
    // `jest.clearAllMocks()` (parent beforeEach) clears call records but NOT implementations, so a
    // reject set by one test would leak into the next. Re-establish success defaults per test; the
    // tests that need a failure override these afterwards.
    beforeEach(() => {
      line.findRichMenuId.mockResolvedValue('rm-default');
      line.linkRichMenuToUser.mockResolvedValue(undefined);
      line.push.mockResolvedValue(undefined);
    });

    /** Prime the role-aware read (`findUnique` selects id/access/deletedAt). */
    const primeRead = (access: AppAccess, deletedAt: Date | null = null) =>
      lineUser.findUnique.mockResolvedValue({ id: 'lu-1', access, deletedAt });

    it('Approve writes access + richMenuType TYPE_2 and applies the TYPE_2 menu on LINE (AC-B7)', async () => {
      primeRead(AppAccess.PENDING);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');

      const result = await service.updateAccess(
        'lu-1',
        AppAccess.ALLOWED,
        SystemRole.ADMIN,
      );

      expect(lineUser.findUnique).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        select: { id: true, access: true, deletedAt: true },
      });
      // A non-REJECTED target ALWAYS writes rejectionReason: null (invariant — clears any prior reason).
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: {
          access: AppAccess.ALLOWED,
          richMenuType: 'TYPE_2',
          rejectionReason: null,
        },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(line.findRichMenuId).toHaveBeenCalledWith(RICH_MENU_SPECS.TYPE_2);
      expect(line.linkRichMenuToUser).toHaveBeenCalledWith('U123', 'rm-type2');
      expect(result.access).toBe(AppAccess.ALLOWED);
      expect(result.richMenuType).toBe('TYPE_2');
      // Pushes the exact ALLOWED copy to the LINE-side U… id (not the cuid).
      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: ALLOWED_MSG },
      ]);
    });

    it('Block writes richMenuType TYPE_1 and applies the TYPE_1 menu on LINE (AC-B8)', async () => {
      primeRead(AppAccess.PENDING);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.BLOCKED,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');

      await service.updateAccess('lu-1', AppAccess.BLOCKED, SystemRole.ADMIN);

      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: {
          access: AppAccess.BLOCKED,
          richMenuType: 'TYPE_1',
          rejectionReason: null,
        },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(line.findRichMenuId).toHaveBeenCalledWith(RICH_MENU_SPECS.TYPE_1);
      expect(line.linkRichMenuToUser).toHaveBeenCalledWith('U123', 'rm-type1');
      // Pushes the exact BLOCKED copy to the LINE-side U… id.
      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: BLOCKED_MSG },
      ]);
    });

    it('PENDING pushes the exact PENDING copy to the LINE-side U… id (SUPER_ADMIN forcing PENDING)', async () => {
      primeRead(AppAccess.ALLOWED);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.PENDING,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');

      await service.updateAccess(
        'lu-1',
        AppAccess.PENDING,
        SystemRole.SUPER_ADMIN,
      );

      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: PENDING_MSG },
      ]);
    });

    it('UNREGISTERED sends NO push (SUPER_ADMIN forcing UNREGISTERED)', async () => {
      primeRead(AppAccess.BLOCKED);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.UNREGISTERED,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');

      await service.updateAccess(
        'lu-1',
        AppAccess.UNREGISTERED,
        SystemRole.SUPER_ADMIN,
      );

      expect(line.push).not.toHaveBeenCalled();
    });

    it('best-effort: a push failure is swallowed (logged, not thrown) after the DB + menu succeed', async () => {
      primeRead(AppAccess.PENDING);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      line.linkRichMenuToUser.mockResolvedValue(undefined);
      line.push.mockRejectedValue(new Error('user blocked the bot'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      // Resolves successfully despite the push failure — no 500/502.
      const result = await service.updateAccess(
        'lu-1',
        AppAccess.ALLOWED,
        SystemRole.ADMIN,
      );

      expect(result.access).toBe(AppAccess.ALLOWED);
      expect(result.richMenuType).toBe('TYPE_2');
      // The DB write + menu link still happened.
      expect(lineUser.update).toHaveBeenCalled();
      expect(line.linkRichMenuToUser).toHaveBeenCalledWith('U123', 'rm-type2');
      expect(warn).toHaveBeenCalled();
    });

    it('502s when the LINE apply fails, but the DB row was already updated (AC-B10)', async () => {
      primeRead(AppAccess.PENDING);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      line.linkRichMenuToUser.mockRejectedValue(new Error('LINE 500'));

      await expect(
        service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN),
      ).rejects.toBeInstanceOf(BadGatewayException);
      // The DB write happened BEFORE the failing LINE call — source of truth is correct.
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: {
          access: AppAccess.ALLOWED,
          richMenuType: 'TYPE_2',
          rejectionReason: null,
        },
        select: LINE_USER_PUBLIC_FIELDS,
      });
    });

    it('is idempotent: an ADMIN retry after a 502 re-writes the same state and re-applies the menu (AC-B9)', async () => {
      // The idempotent ALLOWED→ALLOWED same-state write is exactly the design's 502-retry case.
      primeRead(AppAccess.ALLOWED);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      // First attempt fails on LINE, second succeeds (link is a no-op on LINE for a linked menu).
      line.linkRichMenuToUser
        .mockRejectedValueOnce(new Error('LINE blip'))
        .mockResolvedValueOnce(undefined);

      await expect(
        service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN),
      ).rejects.toBeInstanceOf(BadGatewayException);
      const retry = await service.updateAccess(
        'lu-1',
        AppAccess.ALLOWED,
        SystemRole.ADMIN,
      );
      expect(retry.access).toBe(AppAccess.ALLOWED);
      expect(retry.richMenuType).toBe('TYPE_2');
    });

    it('404s an unknown id for both roles, writes nothing, and never calls LINE (AC-B10)', async () => {
      lineUser.findUnique.mockResolvedValue(null);

      for (const role of [SystemRole.ADMIN, SystemRole.SUPER_ADMIN]) {
        await expect(
          service.updateAccess('gone', AppAccess.ALLOWED, role),
        ).rejects.toThrow(new NotFoundException(LINE_USER_NOT_FOUND));
      }
      expect(lineUser.update).not.toHaveBeenCalled();
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
    });

    // ───────── ADMIN transition matrix (design §3, AC-3.1/AC-3.2) ─────────

    // Every ✅ cell: the four PO pairs + the two idempotent same-state writes (502 retry).
    const ADMIN_ALLOWED: Array<[AppAccess, AppAccess]> = [
      [AppAccess.PENDING, AppAccess.ALLOWED],
      [AppAccess.PENDING, AppAccess.BLOCKED],
      [AppAccess.ALLOWED, AppAccess.BLOCKED],
      [AppAccess.BLOCKED, AppAccess.ALLOWED],
      [AppAccess.ALLOWED, AppAccess.ALLOWED],
      [AppAccess.BLOCKED, AppAccess.BLOCKED],
    ];

    it.each(ADMIN_ALLOWED)(
      'AC-3.1 — ADMIN %s→%s is permitted: writes the DB and drives the LINE side-effect',
      async (from, to) => {
        primeRead(from);
        lineUser.update.mockResolvedValue({
          ...publicRow,
          access: to,
          richMenuType: accessToRichMenuType(to),
        });
        line.findRichMenuId.mockResolvedValue('rm-x');

        const result = await service.updateAccess('lu-1', to, SystemRole.ADMIN);

        expect(result.access).toBe(to);
        expect(lineUser.update).toHaveBeenCalledWith({
          where: { id: 'lu-1' },
          data: {
            access: to,
            richMenuType: accessToRichMenuType(to),
            rejectionReason: null,
          },
          select: LINE_USER_PUBLIC_FIELDS,
        });
        expect(line.linkRichMenuToUser).toHaveBeenCalled();
      },
    );

    // Every ❌ cell: any `to ∈ {PENDING, UNREGISTERED}` from any state, and any `from = UNREGISTERED`.
    const ADMIN_FORBIDDEN: Array<[AppAccess, AppAccess]> = [
      [AppAccess.PENDING, AppAccess.PENDING],
      [AppAccess.PENDING, AppAccess.UNREGISTERED],
      [AppAccess.ALLOWED, AppAccess.PENDING],
      [AppAccess.ALLOWED, AppAccess.UNREGISTERED],
      [AppAccess.BLOCKED, AppAccess.PENDING],
      [AppAccess.BLOCKED, AppAccess.UNREGISTERED],
      [AppAccess.UNREGISTERED, AppAccess.ALLOWED],
      [AppAccess.UNREGISTERED, AppAccess.BLOCKED],
      [AppAccess.UNREGISTERED, AppAccess.PENDING],
      [AppAccess.UNREGISTERED, AppAccess.UNREGISTERED],
    ];

    it.each(ADMIN_FORBIDDEN)(
      'AC-3.2 — ADMIN %s→%s is 403, writes nothing, and never calls LINE',
      async (from, to) => {
        primeRead(from);

        await expect(
          service.updateAccess('lu-1', to, SystemRole.ADMIN),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(lineUser.update).not.toHaveBeenCalled();
        expect(line.findRichMenuId).not.toHaveBeenCalled();
        expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
        expect(line.push).not.toHaveBeenCalled();
      },
    );

    it('AC-3.2 — the 403 carries the forbidden-transition message', async () => {
      primeRead(AppAccess.ALLOWED);
      await expect(
        service.updateAccess('lu-1', AppAccess.PENDING, SystemRole.ADMIN),
      ).rejects.toThrow(
        new ForbiddenException(LINE_USER_ACCESS_TRANSITION_FORBIDDEN),
      );
    });

    // ───────── SUPER_ADMIN bypass (design §3, AC-3.3) ─────────

    const SUPER_ANY: Array<[AppAccess, AppAccess]> = [
      [AppAccess.UNREGISTERED, AppAccess.ALLOWED],
      [AppAccess.ALLOWED, AppAccess.PENDING],
      [AppAccess.BLOCKED, AppAccess.UNREGISTERED],
      [AppAccess.PENDING, AppAccess.PENDING],
    ];

    it.each(SUPER_ANY)(
      'AC-3.3 — SUPER_ADMIN %s→%s bypasses the matrix and writes the DB',
      async (from, to) => {
        primeRead(from);
        lineUser.update.mockResolvedValue({
          ...publicRow,
          access: to,
          richMenuType: accessToRichMenuType(to),
        });
        line.findRichMenuId.mockResolvedValue('rm-x');

        const result = await service.updateAccess(
          'lu-1',
          to,
          SystemRole.SUPER_ADMIN,
        );

        expect(result.access).toBe(to);
        expect(lineUser.update).toHaveBeenCalled();
      },
    );

    // ───────── precedence: 404 BEFORE 403 for a soft-deleted row under ADMIN (AC-3.5) ─────────

    it('AC-3.5 — ADMIN on a soft-deleted id is 404 (not 403), even when the transition would be forbidden', async () => {
      // A forbidden transition (→PENDING) on a soft-deleted row: 404 wins, so the matrix never leaks
      // the row's existence.
      primeRead(AppAccess.PENDING, new Date());

      await expect(
        service.updateAccess('lu-1', AppAccess.PENDING, SystemRole.ADMIN),
      ).rejects.toThrow(new NotFoundException(LINE_USER_NOT_FOUND));
      expect(lineUser.update).not.toHaveBeenCalled();
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
    });

    it('AC-3.5 — ADMIN on a soft-deleted id is 404 even when the transition would be allowed', async () => {
      primeRead(AppAccess.PENDING, new Date());

      await expect(
        service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN),
      ).rejects.toThrow(new NotFoundException(LINE_USER_NOT_FOUND));
      expect(lineUser.update).not.toHaveBeenCalled();
    });

    // ───────── SUPER_ADMIN on a soft-deleted row: skip BOTH side-effects (AC-3.6) ─────────

    it('AC-3.6 — SUPER_ADMIN forcing a soft-deleted user writes the DB, skips menu + push, returns 200', async () => {
      primeRead(AppAccess.PENDING, new Date());
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });

      const result = await service.updateAccess(
        'lu-1',
        AppAccess.ALLOWED,
        SystemRole.SUPER_ADMIN,
      );

      // DB persisted with the derived rich menu (source of truth), no LINE side-effects, no 502/500.
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: {
          access: AppAccess.ALLOWED,
          richMenuType: 'TYPE_2',
          rejectionReason: null,
        },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(result.access).toBe(AppAccess.ALLOWED);
      expect(result.richMenuType).toBe('TYPE_2');
      expect(line.findRichMenuId).not.toHaveBeenCalled();
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
      expect(line.push).not.toHaveBeenCalled();
    });

    it('AC-3.6 — the soft-deleted skip is idempotent: a re-run re-writes the same state and re-skips', async () => {
      primeRead(AppAccess.ALLOWED, new Date());
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });

      const first = await service.updateAccess(
        'lu-1',
        AppAccess.ALLOWED,
        SystemRole.SUPER_ADMIN,
      );
      const second = await service.updateAccess(
        'lu-1',
        AppAccess.ALLOWED,
        SystemRole.SUPER_ADMIN,
      );

      expect(first.access).toBe(AppAccess.ALLOWED);
      expect(second.access).toBe(AppAccess.ALLOWED);
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
      expect(line.push).not.toHaveBeenCalled();
    });

    // ───────── Reject (→REJECTED, mandatory reason) — design §4, AC4/AC5/AC6 ─────────

    it('AC4/AC5 — ADMIN rejects a reachable PENDING user: persists the reason + TYPE_1, fires ONE reject push, 200', async () => {
      primeRead(AppAccess.PENDING);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.REJECTED,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');

      const result = await service.updateAccess(
        'lu-1',
        AppAccess.REJECTED,
        SystemRole.ADMIN,
        'phone is wrong',
      );

      // The write persists the trimmed reason and derives TYPE_1 (invariant: reason set on REJECTED).
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: {
          access: AppAccess.REJECTED,
          richMenuType: 'TYPE_1',
          rejectionReason: 'phone is wrong',
        },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(result.access).toBe(AppAccess.REJECTED);
      // Exactly ONE push, using the reject template — NOT the PENDING copy.
      expect(line.push).toHaveBeenCalledTimes(1);
      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: rejectMsg('phone is wrong') },
      ]);
      const pushed = (
        line.push.mock.calls[0] as [string, { text: string }[]]
      )[1][0].text;
      // Copy-agnostic on purpose: assert the admin's REASON is interpolated into whatever the
      // template currently says, rather than pinning a Thai fragment of the template itself. The
      // service still has to run to produce `pushed`, so this keeps asserting that a Reject routes
      // the reason through buildRejectionMessage — it just no longer breaks when the copy is
      // reworded. (The `toHaveBeenCalledWith` above already pins the exact builder output.)
      expect(pushed).toContain('phone is wrong');
      expect(pushed).not.toBe(PENDING_MSG);
    });

    it.each([
      ['a blank reason', ''],
      ['a missing reason', undefined],
    ])(
      'AC4 — ADMIN →REJECTED with %s is a 400 REJECTION_REASON_REQUIRED, no write, no push',
      async (_label, reason) => {
        primeRead(AppAccess.PENDING);

        await expect(
          service.updateAccess(
            'lu-1',
            AppAccess.REJECTED,
            SystemRole.ADMIN,
            reason,
          ),
        ).rejects.toThrow(new BadRequestException(REJECTION_REASON_REQUIRED));
        expect(lineUser.update).not.toHaveBeenCalled();
        expect(line.push).not.toHaveBeenCalled();
      },
    );

    it('AC3/AC4 — UNREGISTERED→REJECTED is a 403 for ADMIN (policy) and a 400 for SUPER_ADMIN (guard), no write, no push', async () => {
      // ADMIN: the policy forbids →REJECTED from UNREGISTERED → 403 before the reject guards.
      primeRead(AppAccess.UNREGISTERED);
      await expect(
        service.updateAccess(
          'lu-1',
          AppAccess.REJECTED,
          SystemRole.ADMIN,
          'whatever',
        ),
      ).rejects.toThrow(
        new ForbiddenException(LINE_USER_ACCESS_TRANSITION_FORBIDDEN),
      );

      // SUPER_ADMIN bypasses the policy but is still caught by the business guard → 400.
      jest.clearAllMocks();
      line.findRichMenuId.mockResolvedValue('rm-default');
      line.linkRichMenuToUser.mockResolvedValue(undefined);
      line.push.mockResolvedValue(undefined);
      primeRead(AppAccess.UNREGISTERED);
      await expect(
        service.updateAccess(
          'lu-1',
          AppAccess.REJECTED,
          SystemRole.SUPER_ADMIN,
          'whatever',
        ),
      ).rejects.toThrow(new BadRequestException(CANNOT_REJECT_UNREGISTERED));

      expect(lineUser.update).not.toHaveBeenCalled();
      expect(line.push).not.toHaveBeenCalled();
    });

    it.each([AppAccess.ALLOWED, AppAccess.BLOCKED])(
      'AC2 — approving/blocking a formerly-REJECTED user (→%s) CLEARS the reason (rejectionReason: null)',
      async (to) => {
        primeRead(AppAccess.REJECTED);
        lineUser.update.mockResolvedValue({
          ...publicRow,
          access: to,
          richMenuType: accessToRichMenuType(to),
        });
        line.findRichMenuId.mockResolvedValue('rm-x');

        await service.updateAccess('lu-1', to, SystemRole.ADMIN);

        // The write clears the prior rejection — the invariant's non-REJECTED branch.
        expect(lineUser.update).toHaveBeenCalledWith({
          where: { id: 'lu-1' },
          data: {
            access: to,
            richMenuType: accessToRichMenuType(to),
            rejectionReason: null,
          },
          select: LINE_USER_PUBLIC_FIELDS,
        });
        // The existing ALLOWED/BLOCKED copy is used (NOT the reject copy).
        const expected = to === AppAccess.ALLOWED ? ALLOWED_MSG : BLOCKED_MSG;
        expect(line.push).toHaveBeenCalledWith('U123', [
          { type: 'text', text: expected },
        ]);
      },
    );

    it('AC6 — a reject push failure is swallowed (fail-soft): still 200 with the write intact', async () => {
      primeRead(AppAccess.BLOCKED);
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.REJECTED,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');
      line.push.mockRejectedValue(new Error('user blocked the bot'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const result = await service.updateAccess(
        'lu-1',
        AppAccess.REJECTED,
        SystemRole.ADMIN,
        'incomplete documents',
      );

      expect(result.access).toBe(AppAccess.REJECTED);
      expect(lineUser.update).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });

    it('AC6 — SUPER_ADMIN forcing REJECTED on a soft-deleted user persists the reason, skips menu + push, 200', async () => {
      primeRead(AppAccess.BLOCKED, new Date());
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.REJECTED,
        richMenuType: 'TYPE_1',
      });

      const result = await service.updateAccess(
        'lu-1',
        AppAccess.REJECTED,
        SystemRole.SUPER_ADMIN,
        'account under review',
      );

      // DB persisted with the reason; the LINE side is unreachable so BOTH side-effects are skipped.
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: {
          access: AppAccess.REJECTED,
          richMenuType: 'TYPE_1',
          rejectionReason: 'account under review',
        },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(result.access).toBe(AppAccess.REJECTED);
      expect(line.findRichMenuId).not.toHaveBeenCalled();
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
      expect(line.push).not.toHaveBeenCalled();
    });

    it('AC5 — the reject copy lives in buildRejectionMessage: ACCESS_NOTIFICATION_MESSAGES.PENDING is present and .REJECTED is null', () => {
      // Guards against someone moving the reject copy into the shared record (which would regress
      // register()'s PENDING ack) or blanking the PENDING entry.
      //
      // This asserts the SHAPE of the record, not the wording. The Thai copy is product text that
      // is expected to be reworded freely in the service without reddening this suite, so there is
      // deliberately NO pinned literal here and no comparison against `PENDING_MSG` (which now
      // reads from this same record, and would only ever restate `X === X`).
      //
      // The trade-off is explicit: a truncated or accidentally emptied PENDING string is still
      // caught, but a *reworded* one is not. Nothing in this suite verifies the exact PENDING
      // wording any more — if that guarantee is ever wanted back, it needs a pinned literal here,
      // not a reference to the record.
      expect(typeof ACCESS_NOTIFICATION_MESSAGES.PENDING).toBe('string');
      expect(ACCESS_NOTIFICATION_MESSAGES.PENDING?.length).toBeGreaterThan(0);
      expect(ACCESS_NOTIFICATION_MESSAGES.REJECTED).toBeNull();
    });
  });

  // ───────────────────────── updateRegistrationByAdmin (admin registration edit) ─────────────────────────

  describe('updateRegistrationByAdmin', () => {
    const ADMIN_EDIT_DTO: AdminUpdateLineUserRegistrationDto = {
      firstName: 'Edited',
      lastName: 'Name',
      phone: '099-999-9999',
      departmentId: 3,
      personnelRoleId: 4,
    };

    /** The re-read LineUser (LINE_USER_PUBLIC_FIELDS) reflecting the edited registration. */
    const publicUpdated = {
      ...publicRow,
      access: AppAccess.ALLOWED,
      registration: {
        firstName: 'Edited',
        lastName: 'Name',
        phone: '099-999-9999',
        departmentId: 3,
        personnelRoleId: 4,
        department: { name: 'New Dept' },
        personnelRole: { name: 'New Role' },
        createdAt: new Date('2026-07-09T04:30:00.000Z'),
      },
    };

    /**
     * Prime a fully successful world: the target row, an existing registration, an interactive
     * transaction whose option checks pass and whose update resolves, and the re-read public row.
     */
    const primeSuccess = (deletedAt: Date | null = null) => {
      lineUser.findUnique
        .mockResolvedValueOnce({ id: 'lu-1', deletedAt })
        .mockResolvedValueOnce(publicUpdated);
      lineUserRegistration.findFirst.mockResolvedValue({ id: 'reg-1' });
      const tx = {
        department: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
        personnelRole: { findFirst: jest.fn().mockResolvedValue({ id: 4 }) },
        lineUserRegistration: {
          update: jest.fn().mockResolvedValue({ id: 'reg-1' }),
        },
      };
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );
      return tx;
    };

    it.each([SystemRole.ADMIN, SystemRole.SUPER_ADMIN])(
      'AC-B2 — %s edits all five fields, persists them, and returns the updated row (200)',
      async (role) => {
        const tx = primeSuccess();

        const result = await service.updateRegistrationByAdmin(
          'lu-1',
          ADMIN_EDIT_DTO,
          role,
        );

        // `access` is NOT selected on the existence read — the edit is not PENDING-gated (AC-B10).
        expect(lineUser.findUnique).toHaveBeenNthCalledWith(1, {
          where: { id: 'lu-1' },
          select: { id: true, deletedAt: true },
        });
        // All five fields written, keyed on the 1:1 lineUserId.
        expect(tx.lineUserRegistration.update).toHaveBeenCalledWith({
          where: { lineUserId: 'lu-1' },
          data: {
            firstName: 'Edited',
            lastName: 'Name',
            phone: '099-999-9999',
            phoneDigits: '0999999999',
            departmentId: 3,
            personnelRoleId: 4,
          },
        });
        // Response is the re-read LINE_USER_PUBLIC_FIELDS row, incl. the summary option ids (§B-8a).
        expect(result.registration).toMatchObject({
          firstName: 'Edited',
          departmentId: 3,
          department: 'New Dept',
          personnelRoleId: 4,
          personnelRole: 'New Role',
        });
      },
    );

    it('AC-B9 — a registration edit has NO access side-effect: no matrix, no rich menu, no push', async () => {
      primeSuccess();

      await service.updateRegistrationByAdmin(
        'lu-1',
        ADMIN_EDIT_DTO,
        SystemRole.ADMIN,
      );

      // Orthogonal to Item 3: `access`/`richMenuType` are never written and no LINE call fires.
      expect(lineUser.update).not.toHaveBeenCalled();
      expect(line.findRichMenuId).not.toHaveBeenCalled();
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
      expect(line.push).not.toHaveBeenCalled();
    });

    it('AC-B10 — the existence read never selects `access` (not PENDING-gated)', async () => {
      primeSuccess();
      await service.updateRegistrationByAdmin(
        'lu-1',
        ADMIN_EDIT_DTO,
        SystemRole.SUPER_ADMIN,
      );
      const firstSelect = (
        lineUser.findUnique.mock.calls[0] as [
          { select: Record<string, unknown> },
        ]
      )[0].select;
      expect(firstSelect).not.toHaveProperty('access');
    });

    it.each([SystemRole.ADMIN, SystemRole.SUPER_ADMIN])(
      'AC-B6 — a system-reserved departmentId is 400 for %s (reserved-for-everyone), no write',
      async (role) => {
        lineUser.findUnique.mockResolvedValueOnce({
          id: 'lu-1',
          deletedAt: null,
        });
        lineUserRegistration.findFirst.mockResolvedValue({ id: 'reg-1' });
        // The reserved predicate rides in the same WHERE, so a reserved row simply does not match.
        const tx = {
          department: { findFirst: jest.fn().mockResolvedValue(null) },
          personnelRole: { findFirst: jest.fn().mockResolvedValue({ id: 4 }) },
          lineUserRegistration: { update: jest.fn() },
        };
        $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
          cb(tx),
        );

        await expect(
          service.updateRegistrationByAdmin('lu-1', ADMIN_EDIT_DTO, role),
        ).rejects.toThrow(new BadRequestException(INVALID_DEPARTMENT));
        // The role-blind guard hardcodes isSystemReserved: false — SUPER_ADMIN gets no carve-out here.
        expect(tx.department.findFirst).toHaveBeenCalledWith({
          where: { id: 3, deletedAt: null, isSystemReserved: false },
          select: { id: true },
        });
        expect(tx.lineUserRegistration.update).not.toHaveBeenCalled();
      },
    );

    it.each([SystemRole.ADMIN, SystemRole.SUPER_ADMIN])(
      'AC-B6 — a system-reserved personnelRoleId is 400 for %s (reserved-for-everyone), no write',
      async (role) => {
        lineUser.findUnique.mockResolvedValueOnce({
          id: 'lu-1',
          deletedAt: null,
        });
        lineUserRegistration.findFirst.mockResolvedValue({ id: 'reg-1' });
        const tx = {
          department: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
          personnelRole: { findFirst: jest.fn().mockResolvedValue(null) },
          lineUserRegistration: { update: jest.fn() },
        };
        $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
          cb(tx),
        );

        await expect(
          service.updateRegistrationByAdmin('lu-1', ADMIN_EDIT_DTO, role),
        ).rejects.toThrow(new BadRequestException(INVALID_PERSONNEL_ROLE));
        expect(tx.personnelRole.findFirst).toHaveBeenCalledWith({
          where: { id: 4, deletedAt: null, isSystemReserved: false },
          select: { id: true },
        });
        expect(tx.lineUserRegistration.update).not.toHaveBeenCalled();
      },
    );

    it('AC-B6 — a soft-deleted option id is rejected with 400 (same query as reserved), no write', async () => {
      lineUser.findUnique.mockResolvedValueOnce({
        id: 'lu-1',
        deletedAt: null,
      });
      lineUserRegistration.findFirst.mockResolvedValue({ id: 'reg-1' });
      const tx = {
        department: { findFirst: jest.fn().mockResolvedValue(null) },
        personnelRole: { findFirst: jest.fn().mockResolvedValue({ id: 4 }) },
        lineUserRegistration: { update: jest.fn() },
      };
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );

      await expect(
        service.updateRegistrationByAdmin(
          'lu-1',
          ADMIN_EDIT_DTO,
          SystemRole.ADMIN,
        ),
      ).rejects.toThrow(new BadRequestException(INVALID_DEPARTMENT));
      expect(tx.lineUserRegistration.update).not.toHaveBeenCalled();
    });

    it('AC-B7 — a user with NO registration is a distinct 404 (LINE_USER_REGISTRATION_NOT_FOUND), never a 500', async () => {
      lineUser.findUnique.mockResolvedValueOnce({
        id: 'lu-1',
        deletedAt: null,
      });
      lineUserRegistration.findFirst.mockResolvedValue(null);

      await expect(
        service.updateRegistrationByAdmin(
          'lu-1',
          ADMIN_EDIT_DTO,
          SystemRole.ADMIN,
        ),
      ).rejects.toThrow(
        new NotFoundException(LINE_USER_REGISTRATION_NOT_FOUND),
      );
      expect($transaction).not.toHaveBeenCalled();
    });

    it('AC-B8 — an unknown id is a 404 LINE_USER_NOT_FOUND for both roles, no registration read', async () => {
      for (const role of [SystemRole.ADMIN, SystemRole.SUPER_ADMIN]) {
        jest.clearAllMocks();
        lineUser.findUnique.mockResolvedValueOnce(null);
        await expect(
          service.updateRegistrationByAdmin('gone', ADMIN_EDIT_DTO, role),
        ).rejects.toThrow(new NotFoundException(LINE_USER_NOT_FOUND));
        expect(lineUserRegistration.findFirst).not.toHaveBeenCalled();
      }
    });

    it('AC-B8 — a soft-deleted target is a 404 for ADMIN, byte-identical to unknown, no write', async () => {
      lineUser.findUnique.mockResolvedValueOnce({
        id: 'lu-1',
        deletedAt: new Date(),
      });

      await expect(
        service.updateRegistrationByAdmin(
          'lu-1',
          ADMIN_EDIT_DTO,
          SystemRole.ADMIN,
        ),
      ).rejects.toThrow(new NotFoundException(LINE_USER_NOT_FOUND));
      // 404 wins before the registration gate — never leaks that the row exists but is deleted.
      expect(lineUserRegistration.findFirst).not.toHaveBeenCalled();
      expect($transaction).not.toHaveBeenCalled();
    });

    it('AC-B8 — SUPER_ADMIN MAY edit a soft-deleted user; persists, returns 200, no LINE side-effect', async () => {
      const tx = primeSuccess(new Date());

      const result = await service.updateRegistrationByAdmin(
        'lu-1',
        ADMIN_EDIT_DTO,
        SystemRole.SUPER_ADMIN,
      );

      expect(tx.lineUserRegistration.update).toHaveBeenCalled();
      expect(result.access).toBe(AppAccess.ALLOWED);
      // No 502/500 path — a registration edit has no LINE side-effect to skip in the first place.
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
      expect(line.push).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────── realtime fan-out (design §6/§7) ─────────────────────────

  describe('realtime fan-out', () => {
    /** The DTO `publish()` builds from `publicRow` — byte-identical to a `GET /line-users` element. */
    const expectedDto = {
      id: 'lu-1',
      lineUserId: 'U123',
      displayName: 'Alice',
      pictureUrl: null,
      statusMessage: null,
      richMenuType: 'TYPE_1',
      access: AppAccess.PENDING,
      followedAt: '2026-07-07T10:00:00.000Z',
      registration: null,
    };

    it('publish() re-reads with the LOAD-BEARING deletedAt: null filter and the list select', async () => {
      lineUser.findUnique.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
        deletedAt: null,
      });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      lineUser.findFirst.mockResolvedValue(publicRow);

      await service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN);

      expect(lineUser.findFirst).toHaveBeenCalledWith({
        where: { id: 'lu-1', deletedAt: null },
        select: LINE_USER_PUBLIC_FIELDS,
      });
    });

    it('B8 — updateAccess emits ONE lineUser.updated, after applyRichMenu and before the LINE push', async () => {
      lineUser.findUnique.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
        deletedAt: null,
      });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      lineUser.findFirst.mockResolvedValue(publicRow);

      await service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN);

      expect(realtime.emitLineUserUpdated).toHaveBeenCalledTimes(1);
      expect(realtime.emitLineUserUpdated).toHaveBeenCalledWith(expectedDto);
      expect(realtime.emitLineUserCreated).not.toHaveBeenCalled();
      // Ordering: rich menu -> emit -> push. Broadcasting before the menu applied would advertise a
      // state we might still 502 on; emitting after the push would put LINE's latency on the socket.
      const emitAt = realtime.emitLineUserUpdated.mock.invocationCallOrder[0];
      expect(emitAt).toBeGreaterThan(
        line.linkRichMenuToUser.mock.invocationCallOrder[0],
      );
      expect(emitAt).toBeLessThan(line.push.mock.invocationCallOrder[0]);
    });

    it('B8 — the 502 rich-menu path emits NOTHING (the retry re-emits)', async () => {
      lineUser.findUnique.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
        deletedAt: null,
      });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue(null); // menu missing on LINE -> 502

      await expect(
        service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN),
      ).rejects.toThrow(BadGatewayException);

      expect(realtime.emitLineUserUpdated).not.toHaveBeenCalled();
    });

    it.each([
      [
        '404 (unknown id)',
        () => lineUser.findUnique.mockResolvedValue(null),
        SystemRole.ADMIN,
        AppAccess.ALLOWED,
      ],
      [
        '403 (forbidden ADMIN transition)',
        () =>
          lineUser.findUnique.mockResolvedValue({
            id: 'lu-1',
            access: AppAccess.ALLOWED,
            deletedAt: null,
          }),
        SystemRole.ADMIN,
        AppAccess.PENDING,
      ],
      [
        '400 (reject from UNREGISTERED)',
        () =>
          lineUser.findUnique.mockResolvedValue({
            id: 'lu-1',
            access: AppAccess.UNREGISTERED,
            deletedAt: null,
          }),
        SystemRole.SUPER_ADMIN,
        AppAccess.REJECTED,
      ],
    ])(
      'B8 — a failed mutation (%s) emits nothing at all',
      async (_label, prime, role, target) => {
        prime();

        await expect(
          service.updateAccess('lu-1', target, role),
        ).rejects.toThrow();

        expect(realtime.emitLineUserUpdated).not.toHaveBeenCalled();
        expect(realtime.emitLineUserCreated).not.toHaveBeenCalled();
        expect(realtime.emitLineUserDeleted).not.toHaveBeenCalled();
      },
    );

    it('§6.4 — a SUPER_ADMIN PATCH on a SOFT-DELETED row broadcasts nothing', async () => {
      lineUser.findUnique.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
        deletedAt: new Date(),
      });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.BLOCKED,
      });
      // Even if the guard above were removed, publish()'s filter returns no row for a deleted id.
      lineUser.findFirst.mockResolvedValue(null);

      await service.updateAccess(
        'lu-1',
        AppAccess.BLOCKED,
        SystemRole.SUPER_ADMIN,
      );

      expect(realtime.emitLineUserUpdated).not.toHaveBeenCalled();
      expect(realtime.emitLineUserCreated).not.toHaveBeenCalled();
    });

    it('B11 — upsertOnFollow emits lineUser.created', async () => {
      lineUser.upsert.mockResolvedValue({ id: 'lu-1' });
      lineUser.findFirst.mockResolvedValue(publicRow);

      await service.upsertOnFollow({ lineUserId: 'U123' });

      expect(realtime.emitLineUserCreated).toHaveBeenCalledTimes(1);
      expect(realtime.emitLineUserCreated).toHaveBeenCalledWith(expectedDto);
    });

    it('B11 — register() emits CREATED when the transaction created the LineUser row', async () => {
      const tx = makeTx();
      tx.department.findFirst.mockResolvedValue({ id: 1 });
      tx.personnelRole.findFirst.mockResolvedValue({ id: 2 });
      tx.lineUser.findFirst.mockResolvedValue(null); // LIFF-first caller: no prior row
      tx.lineUser.create.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.lineUserRegistration.create.mockResolvedValue(OWNER_REGISTRATION_ROW);
      tx.lineUser.update.mockResolvedValue({ access: AppAccess.PENDING });
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );
      lineUser.findFirst.mockResolvedValue(publicRow);

      await service.register('U123', VALID_DTO);

      expect(realtime.emitLineUserCreated).toHaveBeenCalledTimes(1);
      expect(realtime.emitLineUserUpdated).not.toHaveBeenCalled();
    });

    it('B11 — register() emits UPDATED when the LineUser row already existed (follow first)', async () => {
      const tx = makeTx();
      tx.department.findFirst.mockResolvedValue({ id: 1 });
      tx.personnelRole.findFirst.mockResolvedValue({ id: 2 });
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.lineUserRegistration.create.mockResolvedValue(OWNER_REGISTRATION_ROW);
      tx.lineUser.update.mockResolvedValue({ access: AppAccess.PENDING });
      $transaction.mockImplementation((cb: (client: typeof tx) => unknown) =>
        cb(tx),
      );
      lineUser.findFirst.mockResolvedValue(publicRow);

      await service.register('U123', VALID_DTO);

      expect(realtime.emitLineUserUpdated).toHaveBeenCalledTimes(1);
      expect(realtime.emitLineUserCreated).not.toHaveBeenCalled();
      expect(tx.lineUser.create).not.toHaveBeenCalled();
    });

    it('B9 — the LIFF self-edit emits ONE lineUser.updated', async () => {
      $transaction.mockImplementation((cb: (client: unknown) => unknown) =>
        cb({ lineUser, lineUserRegistration, department, personnelRole }),
      );
      lineUser.findFirst
        .mockResolvedValueOnce({ id: 'lu-1', access: AppAccess.PENDING }) // the caller's row
        .mockResolvedValueOnce(publicRow); // publish()'s re-read
      department.findFirst.mockResolvedValue({ id: 1 });
      personnelRole.findFirst.mockResolvedValue({ id: 2 });
      lineUserRegistration.update.mockResolvedValue(OWNER_REGISTRATION_ROW);

      await service.updateRegistration('U123', { ...VALID_DTO });

      expect(realtime.emitLineUserUpdated).toHaveBeenCalledTimes(1);
      expect(realtime.emitLineUserUpdated).toHaveBeenCalledWith(expectedDto);
    });

    it('B9 — the admin registration edit emits ONE lineUser.updated', async () => {
      lineUser.findUnique
        .mockResolvedValueOnce({ id: 'lu-1', deletedAt: null })
        .mockResolvedValueOnce(publicRow);
      lineUserRegistration.findFirst.mockResolvedValue({ id: 'reg-1' });
      $transaction.mockImplementation((cb: (client: unknown) => unknown) =>
        cb({
          department: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
          personnelRole: { findFirst: jest.fn().mockResolvedValue({ id: 4 }) },
          lineUserRegistration: {
            update: jest.fn().mockResolvedValue({ id: 'reg-1' }),
          },
        }),
      );
      lineUser.findFirst.mockResolvedValue(publicRow);

      await service.updateRegistrationByAdmin(
        'lu-1',
        {
          firstName: 'Edited',
          lastName: 'Name',
          phone: '099-999-9999',
          departmentId: 3,
          personnelRoleId: 4,
        },
        SystemRole.ADMIN,
      );

      expect(realtime.emitLineUserUpdated).toHaveBeenCalledTimes(1);
    });

    it('B15/B17 — a publish failure is swallowed, and the log line carries id + kind ONLY', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      lineUser.findUnique.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
        deletedAt: null,
      });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      lineUser.findFirst.mockRejectedValue(new Error('db gone'));

      // The write already committed — the mutation must still succeed.
      await expect(
        service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN),
      ).resolves.toMatchObject({ id: 'lu-1' });

      expect(realtime.emitLineUserUpdated).not.toHaveBeenCalled();
      const line0 = warn.mock.calls
        .map((call) => String(call[0]))
        .find((msg) => msg.includes('Realtime publish failed'));
      expect(line0).toContain('id=lu-1');
      expect(line0).toContain('kind=updated');
      // PDPA: never a name, phone or the DTO itself.
      expect(line0).not.toContain('Alice');
      expect(line0).not.toContain('081-234-5678');
      warn.mockRestore();
    });

    it('B15 — an emit that throws cannot fail the mutation (the gateway swallows, the service too)', async () => {
      realtime.emitLineUserUpdated.mockImplementationOnce(() => {
        throw new Error('transport down');
      });
      lineUser.findUnique.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
        deletedAt: null,
      });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      lineUser.findFirst.mockResolvedValue(publicRow);

      await expect(
        service.updateAccess('lu-1', AppAccess.ALLOWED, SystemRole.ADMIN),
      ).resolves.toMatchObject({ id: 'lu-1' });
    });
  });
});
