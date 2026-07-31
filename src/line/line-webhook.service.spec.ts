import { Test, TestingModule } from '@nestjs/testing';
import type { webhook } from '@line/bot-sdk';
import { LineService } from './line.service';
import { LineUserService } from './line-user.service';
import { LineWebhookService } from './line-webhook.service';
import { RICH_MENU_SHORTCUTS } from './rich-menu.constants';

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

  const postbackEvent = (data: string): webhook.Event =>
    ({
      type: 'postback',
      replyToken: 'rt',
      source: { type: 'user', userId: 'U4' },
      postback: { data },
    }) as unknown as webhook.Event;

  // Every shortcut is asserted from the shared constant rather than a hardcoded
  // string: the whole point of RICH_MENU_SHORTCUTS is that setup-rich-menu.ts and
  // the webhook agree on the token, so a test that restated the literal would pass
  // even if the two drifted apart.
  it.each(Object.values(RICH_MENU_SHORTCUTS))(
    'postback: answers $data with its pending-page message',
    async (shortcut) => {
      await service.handleEvents([postbackEvent(shortcut.data)]);

      expect(line.reply).toHaveBeenCalledWith('rt', [
        { type: 'text', text: shortcut.pendingMessage },
      ]);
    },
  );

  it('postback: replies generically to unknown data and never echoes it', async () => {
    await service.handleEvents([postbackEvent('action=not-a-real-button')]);

    expect(line.reply).toHaveBeenCalledTimes(1);
    const [, messages] = line.reply.mock.calls[0] as [
      string,
      { type: string; text: string }[],
    ];
    expect(messages[0].text).not.toContain('action=not-a-real-button');
  });

  it('postback: does not reply when there is no replyToken', async () => {
    const event = {
      type: 'postback',
      source: { type: 'user', userId: 'U5' },
      postback: { data: RICH_MENU_SHORTCUTS.settings.data },
    } as unknown as webhook.Event;

    await service.handleEvents([event]);

    expect(line.reply).not.toHaveBeenCalled();
  });
});
