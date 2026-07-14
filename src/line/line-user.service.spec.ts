import { NotFoundException } from '@nestjs/common';
import { AppAccess, Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { LineService } from './line.service';
import { LINE_USER_PUBLIC_FIELDS, LineUserService } from './line-user.service';
import { LINE_USER_NOT_FOUND } from './line-users.errors';

interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

describe('LineUserService', () => {
  let service: LineUserService;
  const lineUser = {
    upsert: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  };
  const $transaction = jest.fn();
  const line = {
    findRichMenuId: jest.fn(),
    linkRichMenuToUser: jest.fn(),
  };

  const publicRow = {
    id: 'lu-1',
    lineUserId: 'U123',
    displayName: 'Alice',
    pictureUrl: null,
    statusMessage: null,
    richMenuType: 'TYPE_1',
    access: AppAccess.PENDING,
    followedAt: new Date('2026-07-07T10:00:00.000Z'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LineUserService,
        { provide: PrismaService, useValue: { lineUser, $transaction } },
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
    } as never);
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
      } as never),
    ).rejects.toThrow(/not found on LINE/);
    expect(line.linkRichMenuToUser).not.toHaveBeenCalled();
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
      });
      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        total: 1,
        totalPages: 1,
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
    it('loads the target with deletedAt: null, then writes only `access` with the DTO select (AC-B8)', async () => {
      lineUser.findFirst.mockResolvedValue({ id: 'lu-1' });
      lineUser.update.mockResolvedValue({
        ...publicRow,
        access: AppAccess.BLOCKED,
      });

      const result = await service.updateAccess('lu-1', AppAccess.BLOCKED);

      expect(lineUser.findFirst).toHaveBeenCalledWith({
        where: { id: 'lu-1', deletedAt: null },
        select: { id: true },
      });
      expect(lineUser.update).toHaveBeenCalledWith({
        where: { id: 'lu-1' },
        data: { access: AppAccess.BLOCKED },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      expect(result.access).toBe(AppAccess.BLOCKED);
      expect(result.id).toBe('lu-1');
    });

    it('404s an unknown or soft-deleted id and writes nothing (AC-B10)', async () => {
      lineUser.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAccess('gone', AppAccess.ALLOWED),
      ).rejects.toThrow(new NotFoundException(LINE_USER_NOT_FOUND));
      expect(lineUser.update).not.toHaveBeenCalled();
    });
  });
});
