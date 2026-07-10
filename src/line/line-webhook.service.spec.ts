import { Test, TestingModule } from '@nestjs/testing';
import type { webhook } from '@line/bot-sdk';
import { LineService } from './line.service';
import { LineUserService } from './line-user.service';
import { LineWebhookService } from './line-webhook.service';

describe('LineWebhookService', () => {
  let service: LineWebhookService;
  const line = { getProfile: jest.fn(), reply: jest.fn() };
  const users = {
    upsertOnFollow: jest.fn(),
    softDeleteByLineUserId: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    line.reply.mockResolvedValue(undefined);
    users.upsertOnFollow.mockResolvedValue(undefined);
    users.softDeleteByLineUserId.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LineWebhookService,
        { provide: LineService, useValue: line },
        { provide: LineUserService, useValue: users },
      ],
    }).compile();
    service = module.get<LineWebhookService>(LineWebhookService);
  });

  it('follow: fetches profile, upserts the user, and replies', async () => {
    line.getProfile.mockResolvedValue({ displayName: 'Alice', language: 'en' });
    const event = {
      type: 'follow',
      replyToken: 'rt',
      source: { type: 'user', userId: 'U1' },
    } as unknown as webhook.Event;

    await service.handleEvents([event]);

    expect(line.getProfile).toHaveBeenCalledWith('U1');
    expect(users.upsertOnFollow).toHaveBeenCalledWith(
      expect.objectContaining({ lineUserId: 'U1', displayName: 'Alice' }),
    );
    expect(line.reply).toHaveBeenCalled();
  });

  it('follow: still stores the user when getProfile fails', async () => {
    line.getProfile.mockRejectedValue(new Error('bad token'));
    const event = {
      type: 'follow',
      replyToken: 'rt',
      source: { type: 'user', userId: 'U2' },
    } as unknown as webhook.Event;

    await service.handleEvents([event]);

    expect(users.upsertOnFollow).toHaveBeenCalledWith(
      expect.objectContaining({ lineUserId: 'U2', displayName: null }),
    );
  });

  it('unfollow: soft-deletes the user', async () => {
    const event = {
      type: 'unfollow',
      source: { type: 'user', userId: 'U3' },
    } as unknown as webhook.Event;

    await service.handleEvents([event]);

    expect(users.softDeleteByLineUserId).toHaveBeenCalledWith('U3');
  });
});
