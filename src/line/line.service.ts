import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { messagingApi } from '@line/bot-sdk';

/**
 * Thin wrapper over the LINE Messaging API SDK: reply/push messaging plus
 * rich-menu management. Credentials come from LINE_CHANNEL_ACCESS_TOKEN.
 */
@Injectable()
export class LineService {
  private readonly logger = new Logger(LineService.name);
  private readonly client: messagingApi.MessagingApiClient;
  private readonly blobClient: messagingApi.MessagingApiBlobClient;

  constructor(config: ConfigService) {
    const channelAccessToken = config.get<string>(
      'LINE_CHANNEL_ACCESS_TOKEN',
      '',
    );
    if (!channelAccessToken) {
      this.logger.warn(
        'LINE_CHANNEL_ACCESS_TOKEN is not set — messaging/rich-menu calls will fail until configured.',
      );
    }
    this.client = new messagingApi.MessagingApiClient({ channelAccessToken });
    this.blobClient = new messagingApi.MessagingApiBlobClient({
      channelAccessToken,
    });
  }

  // --- Messaging ---------------------------------------------------------

  reply(
    replyToken: string,
    messages: messagingApi.Message[],
  ): Promise<unknown> {
    return this.client.replyMessage({ replyToken, messages });
  }

  push(to: string, messages: messagingApi.Message[]): Promise<unknown> {
    return this.client.pushMessage({ to, messages });
  }

  getProfile(userId: string): Promise<messagingApi.UserProfileResponse> {
    return this.client.getProfile(userId);
  }

  // --- Rich menu management ---------------------------------------------

  async createRichMenu(
    richMenu: messagingApi.RichMenuRequest,
  ): Promise<string> {
    const { richMenuId } = await this.client.createRichMenu(richMenu);
    return richMenuId;
  }

  async setRichMenuImage(
    richMenuId: string,
    image: Buffer,
    contentType = 'image/png',
  ): Promise<void> {
    const blob = new Blob([new Uint8Array(image)], { type: contentType });
    await this.blobClient.setRichMenuImage(richMenuId, blob);
  }

  setDefaultRichMenu(richMenuId: string): Promise<unknown> {
    return this.client.setDefaultRichMenu(richMenuId);
  }

  linkRichMenuToUser(userId: string, richMenuId: string): Promise<unknown> {
    return this.client.linkRichMenuIdToUser(userId, richMenuId);
  }

  async listRichMenus(): Promise<messagingApi.RichMenuResponse[]> {
    const { richmenus } = await this.client.getRichMenuList();
    return richmenus;
  }

  /** Resolve a rich menu's id by name + size (deterministic despite duplicates). */
  async findRichMenuId(spec: {
    name: string;
    width: number;
    height: number;
  }): Promise<string | null> {
    const menus = await this.listRichMenus();
    const match = menus.find(
      (m) =>
        m.name === spec.name &&
        m.size?.width === spec.width &&
        m.size?.height === spec.height,
    );
    return match?.richMenuId ?? null;
  }

  deleteRichMenu(richMenuId: string): Promise<unknown> {
    return this.client.deleteRichMenu(richMenuId);
  }
}
