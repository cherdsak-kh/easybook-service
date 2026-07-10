import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { LineService } from './line.service';
import { LineUserService } from './line-user.service';

describe('LineUserService', () => {
  let service: LineUserService;
  const lineUser = {
    upsert: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  };
  const line = {
    findRichMenuId: jest.fn(),
    linkRichMenuToUser: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LineUserService,
        { provide: PrismaService, useValue: { lineUser } },
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
});
