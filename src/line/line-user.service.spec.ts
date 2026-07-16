import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppAccess, Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { UpdateLineUserRegistrationDto } from './dto/update-line-user-registration.dto';
import { LineService } from './line.service';
import {
  accessToRichMenuType,
  LINE_USER_PUBLIC_FIELDS,
  LineUserService,
} from './line-user.service';
import {
  ALREADY_REGISTERED,
  INVALID_DEPARTMENT,
  INVALID_PERSONNEL_ROLE,
  LINE_USER_NOT_FOUND,
  REGISTRATION_NOT_EDITABLE,
  STAFF_ID_TAKEN,
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
  staffId: '6412345678',
  phone: '081-234-5678',
  departmentId: 1,
  personnelRoleId: 2,
};

/** Owner-facing registration row (matches REGISTRATION_OWNER_SELECT: ids + resolved option names). */
const OWNER_REGISTRATION_ROW = {
  id: 'reg-1',
  firstName: 'Somchai',
  lastName: 'Jaidee',
  staffId: '6412345678',
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

  // The exact push copy per target access (mirrors ACCESS_NOTIFICATION_MESSAGES in the service).
  const ALLOWED_MSG =
    'ยินดีด้วย! บัญชีของคุณได้รับการอนุมัติการใช้งานเรียบร้อยแล้ว คุณสามารถกดปุ่มจองคิวที่เมนูด้านล่างเพื่อทำรายการได้ทันทีครับ 🎉';
  const BLOCKED_MSG =
    'ขออภัย บัญชีการใช้งานของคุณถูกระงับสิทธิ์ชั่วคราวโดยผู้ดูแลระบบ หากมีข้อสงสัยกรุณาติดต่อเจ้าหน้าที่สถาบัน';
  const PENDING_MSG =
    'ระบบได้รับข้อมูลการลงทะเบียนของคุณแล้ว เจ้าหน้าที่กำลังดำเนินการตรวจสอบข้อมูลกรุณารอสักครู่ครับ ⏳';

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
      ],
    }).compile();
    service = module.get<LineUserService>(LineUserService);
  });

  it('upserts on follow: create by lineUserId, restore (deletedAt=null) on update', async () => {
    lineUser.upsert.mockResolvedValue({ id: '1' });
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

  it('soft-deletes only active rows for the given lineUserId', async () => {
    lineUser.updateMany.mockResolvedValue({ count: 1 });
    await service.softDeleteByLineUserId('U123');

    const [arg] = lineUser.updateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(arg.where).toEqual({ lineUserId: 'U123', deletedAt: null });
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
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
    expect(line.findRichMenuId).toHaveBeenCalledWith({
      name: 'easy-book-main',
      width: 2500,
      height: 1686,
    });
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
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      expect(personnelRole.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      expect(result).toEqual({
        departments: [{ id: 1, name: 'Biology' }],
        personnelRoles: [{ id: 2, name: 'Teacher' }],
      });
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
          data: { lineUserId: 'lu-1', ...VALID_DTO },
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
        staffId: '6412345678',
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

    it('maps a P2002 on staffId to a 409 STAFF_ID_TAKEN (SC-B1)', async () => {
      const tx = primeTx();
      tx.lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.UNREGISTERED,
      });
      tx.lineUserRegistration.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
          meta: { target: ['staffId'] },
        }),
      );

      await expect(service.register('U123', VALID_DTO)).rejects.toThrow(
        new ConflictException(STAFF_ID_TAKEN),
      );
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

  // ───────────────────────── updateRegistration (PENDING self-edit) ─────────────────────────

  describe('updateRegistration', () => {
    const EDIT_DTO: UpdateLineUserRegistrationDto = { ...VALID_DTO };

    it('updates all fields for a PENDING caller, keeps PENDING, and sends NO push (SC-B8)', async () => {
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
            staffId: '6412345678',
            phone: '081-234-5678',
            departmentId: 1,
            personnelRoleId: 2,
          },
        }),
      );
      expect(result.access).toBe(AppAccess.PENDING);
      expect(result.registration).toMatchObject({
        staffId: '6412345678',
        department: 'Computer Science',
        personnelRole: 'Teacher',
      });
      // No LINE push on a field-edit (Q6).
      expect(line.push).not.toHaveBeenCalled();
    });

    it.each([AppAccess.ALLOWED, AppAccess.BLOCKED, AppAccess.UNREGISTERED])(
      '403s a non-PENDING caller (%s) with no write (SC-B9)',
      async (access) => {
        lineUser.findFirst.mockResolvedValue({ id: 'lu-1', access });

        await expect(
          service.updateRegistration('U123', EDIT_DTO),
        ).rejects.toThrow(new ForbiddenException(REGISTRATION_NOT_EDITABLE));
        expect(lineUserRegistration.update).not.toHaveBeenCalled();
      },
    );

    it('403s when the caller has no active LineUser row (SC-B9)', async () => {
      lineUser.findFirst.mockResolvedValue(null);

      await expect(
        service.updateRegistration('U123', EDIT_DTO),
      ).rejects.toThrow(new ForbiddenException(REGISTRATION_NOT_EDITABLE));
      expect(lineUserRegistration.update).not.toHaveBeenCalled();
    });

    it('rejects a deleted/unknown option id with 400 and no write (SC-B10)', async () => {
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

    it('maps a P2002 on staffId (another registration) to 409 STAFF_ID_TAKEN (SC-B10)', async () => {
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });
      department.findFirst.mockResolvedValue({ id: 1 });
      personnelRole.findFirst.mockResolvedValue({ id: 2 });
      lineUserRegistration.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
          meta: { target: ['staffId'] },
        }),
      );

      await expect(
        service.updateRegistration('U123', EDIT_DTO),
      ).rejects.toThrow(new ConflictException(STAFF_ID_TAKEN));
    });
  });

  // ───────────────────────── getStatus ─────────────────────────

  describe('getStatus', () => {
    it('returns access + registration (with resolved option names) for an existing user', async () => {
      lineUser.findFirst.mockResolvedValue({
        id: 'lu-1',
        access: AppAccess.PENDING,
      });
      lineUserRegistration.findFirst.mockResolvedValue(OWNER_REGISTRATION_ROW);

      const result = await service.getStatus('U123');

      expect(lineUserRegistration.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lineUserId: 'lu-1', deletedAt: null },
        }),
      );
      expect(result.access).toBe(AppAccess.PENDING);
      expect(result.registration?.staffId).toBe('6412345678');
      expect(result.registration?.department).toBe('Computer Science');
      expect(result.registration?.personnelRole).toBe('Teacher');
    });

    it('gives a LIFF-first caller a fresh UNREGISTERED state + null registration', async () => {
      lineUser.findFirst.mockResolvedValue(null);
      lineUser.create.mockResolvedValue({
        id: 'lu-new',
        access: AppAccess.UNREGISTERED,
      });
      lineUserRegistration.findFirst.mockResolvedValue(null);

      const result = await service.getStatus('U-fresh');

      expect(result.access).toBe(AppAccess.UNREGISTERED);
      expect(result.registration).toBeNull();
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

    it('maps a nested registration relation into the compact summary with resolved option names (AC-B11/SC-B5)', async () => {
      $transaction.mockResolvedValue([
        [
          {
            ...publicRow,
            access: AppAccess.ALLOWED,
            registration: {
              firstName: 'Somchai',
              lastName: 'Jaidee',
              staffId: '6412345678',
              phone: '081-234-5678',
              department: { name: 'Computer Science' },
              personnelRole: { name: 'Teacher' },
            },
          },
        ],
        1,
      ]);

      const result = await service.findManyPaginated({ page: 1, limit: 20 });

      expect(result.data[0].registration).toEqual({
        firstName: 'Somchai',
        lastName: 'Jaidee',
        staffId: '6412345678',
        phone: '081-234-5678',
        department: 'Computer Science',
        personnelRole: 'Teacher',
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
    it('Approve writes access + richMenuType TYPE_2 and applies the TYPE_2 menu on LINE (AC-B7)', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');

      const result = await service.updateAccess('lu-1', AppAccess.ALLOWED);

      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: { access: AppAccess.ALLOWED, richMenuType: 'TYPE_2' },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(line.findRichMenuId).toHaveBeenCalledWith({
        name: 'easy-book-main',
        width: 2500,
        height: 1686,
      });
      expect(line.linkRichMenuToUser).toHaveBeenCalledWith('U123', 'rm-type2');
      expect(result.access).toBe(AppAccess.ALLOWED);
      expect(result.richMenuType).toBe('TYPE_2');
      // Pushes the exact ALLOWED copy to the LINE-side U… id (not the cuid).
      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: ALLOWED_MSG },
      ]);
    });

    it('Block writes richMenuType TYPE_1 and applies the TYPE_1 menu on LINE (AC-B8)', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.BLOCKED,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');

      await service.updateAccess('lu-1', AppAccess.BLOCKED);

      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: { access: AppAccess.BLOCKED, richMenuType: 'TYPE_1' },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(line.findRichMenuId).toHaveBeenCalledWith({
        name: 'easy-book-liff',
        width: 2500,
        height: 843,
      });
      expect(line.linkRichMenuToUser).toHaveBeenCalledWith('U123', 'rm-type1');
      // Pushes the exact BLOCKED copy to the LINE-side U… id.
      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: BLOCKED_MSG },
      ]);
    });

    it('PENDING pushes the exact PENDING copy to the LINE-side U… id', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.PENDING,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');

      await service.updateAccess('lu-1', AppAccess.PENDING);

      expect(line.push).toHaveBeenCalledWith('U123', [
        { type: 'text', text: PENDING_MSG },
      ]);
    });

    it('UNREGISTERED sends NO push', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.UNREGISTERED,
        richMenuType: 'TYPE_1',
      });
      line.findRichMenuId.mockResolvedValue('rm-type1');

      await service.updateAccess('lu-1', AppAccess.UNREGISTERED);

      expect(line.push).not.toHaveBeenCalled();
    });

    it('best-effort: a push failure is swallowed (logged, not thrown) after the DB + menu succeed', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
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
      const result = await service.updateAccess('lu-1', AppAccess.ALLOWED);

      expect(result.access).toBe(AppAccess.ALLOWED);
      expect(result.richMenuType).toBe('TYPE_2');
      // The DB write + menu link still happened.
      expect(lineUser.update).toHaveBeenCalled();
      expect(line.linkRichMenuToUser).toHaveBeenCalledWith('U123', 'rm-type2');
      expect(warn).toHaveBeenCalled();
    });

    it('502s when the LINE apply fails, but the DB row was already updated (AC-B10)', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.ALLOWED,
        richMenuType: 'TYPE_2',
      });
      line.findRichMenuId.mockResolvedValue('rm-type2');
      line.linkRichMenuToUser.mockRejectedValue(new Error('LINE 500'));

      await expect(
        service.updateAccess('lu-1', AppAccess.ALLOWED),
      ).rejects.toBeInstanceOf(BadGatewayException);
      // The DB write happened BEFORE the failing LINE call — source of truth is correct.
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: { access: AppAccess.ALLOWED, richMenuType: 'TYPE_2' },
        select: LINE_USER_PUBLIC_FIELDS,
      });
    });

    it('is idempotent: a retry after a 502 re-writes the same state and re-applies the menu (AC-B9)', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
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
        service.updateAccess('lu-1', AppAccess.ALLOWED),
      ).rejects.toBeInstanceOf(BadGatewayException);
      const retry = await service.updateAccess('lu-1', AppAccess.ALLOWED);
      expect(retry.access).toBe(AppAccess.ALLOWED);
      expect(retry.richMenuType).toBe('TYPE_2');
    });

    it('404s an unknown or soft-deleted id, writes nothing, and never calls LINE (AC-B10)', async () => {
      lineUser.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAccess('gone', AppAccess.ALLOWED),
      ).rejects.toThrow(new NotFoundException(LINE_USER_NOT_FOUND));
      expect(lineUser.update).not.toHaveBeenCalled();
      expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
    });
  });
});
