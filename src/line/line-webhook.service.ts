import { Injectable, Logger } from '@nestjs/common';
import type { webhook } from '@line/bot-sdk';
import { LineService } from './line.service';
import { LineUserService } from './line-user.service';

/**
 * Dispatches incoming LINE webhook events to handlers. Each event is handled
 * independently; a failure is logged but never fails the webhook response (LINE
 * would otherwise retry). URL/LIFF rich-menu buttons open directly and do not
 * produce events here — only postback/message actions do.
 */
@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger(LineWebhookService.name);

  constructor(
    private readonly line: LineService,
    private readonly users: LineUserService,
  ) {}

  async handleEvents(events: webhook.Event[]): Promise<void> {
    await Promise.all(
      events.map((event) =>
        this.handleEvent(event).catch((error: unknown) =>
          this.logger.warn(
            `Failed handling '${event.type}' event: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        ),
      ),
    );
  }

  private async handleEvent(event: webhook.Event): Promise<void> {
    switch (event.type) {
      case 'follow': {
        const userId = this.userIdOf(event);
        if (userId) {
          await this.storeFollower(userId);
        }
        if (event.replyToken) {
          await this.line.reply(event.replyToken, [
            { type: 'text', text: 'Welcome to easy-book-app! 🎉' },
          ]);
        }
        break;
      }

      case 'unfollow': {
        const userId = this.userIdOf(event);
        if (userId) {
          await this.users.softDeleteByLineUserId(userId);
        }
        break;
      }

      case 'message':
        if (event.message.type === 'text' && event.replyToken) {
          await this.line.reply(event.replyToken, [
            { type: 'text', text: `You said: ${event.message.text}` },
          ]);
        }
        break;

      case 'postback':
        if (event.replyToken) {
          await this.line.reply(event.replyToken, [
            { type: 'text', text: `Received action: ${event.postback.data}` },
          ]);
        }
        break;

      default:
        this.logger.debug(`Unhandled event type: ${event.type}`);
    }
  }

  private userIdOf(event: webhook.Event): string | undefined {
    return event.source?.type === 'user' ? event.source.userId : undefined;
  }

  /** Best-effort profile fetch + upsert; the row is stored even if getProfile fails. */
  private async storeFollower(userId: string): Promise<void> {
    let profile: Partial<{
      displayName: string;
      pictureUrl: string;
      statusMessage: string;
      language: string;
    }> = {};
    try {
      profile = await this.line.getProfile(userId);
    } catch (error) {
      this.logger.warn(
        `getProfile failed for ${userId} (storing without profile): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.users.upsertOnFollow({
      lineUserId: userId,
      displayName: profile.displayName ?? null,
      pictureUrl: profile.pictureUrl ?? null,
      statusMessage: profile.statusMessage ?? null,
      language: profile.language ?? null,
    });
  }
}
