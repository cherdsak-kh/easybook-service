import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LineUserController } from './line-user.controller';
import { LineUserService } from './line-user.service';

describe('LineUserController', () => {
  let controller: LineUserController;
  const users = {
    setRichMenuType: jest.fn(),
    applyRichMenu: jest.fn(),
    toDto: jest.fn((u) => ({ lineUserId: u.lineUserId })),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LineUserController],
      providers: [{ provide: LineUserService, useValue: users }],
    }).compile();
    controller = module.get<LineUserController>(LineUserController);
  });

  it('updates the DB, applies on LINE, and returns the dto', async () => {
    const user = { lineUserId: 'U1', richMenuType: 'TYPE_2' };
    users.setRichMenuType.mockResolvedValue(user);
    users.applyRichMenu.mockResolvedValue(undefined);

    const result = await controller.updateRichMenu('U1', {
      richMenuType: 'TYPE_2',
    });

    expect(users.setRichMenuType).toHaveBeenCalledWith('U1', 'TYPE_2');
    expect(users.applyRichMenu).toHaveBeenCalledWith(user);
    expect(result).toEqual({ lineUserId: 'U1' });
  });

  it('404s when the user is not active', async () => {
    users.setRichMenuType.mockResolvedValue(null);
    await expect(
      controller.updateRichMenu('Ux', { richMenuType: 'TYPE_1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(users.applyRichMenu).not.toHaveBeenCalled();
  });

  it('502s when applying on LINE fails', async () => {
    users.setRichMenuType.mockResolvedValue({ lineUserId: 'U1' });
    users.applyRichMenu.mockRejectedValue(new Error('menu missing'));
    await expect(
      controller.updateRichMenu('U1', { richMenuType: 'TYPE_2' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
