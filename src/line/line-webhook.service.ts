import { Injectable, Logger } from '@nestjs/common';
import type { webhook } from '@line/bot-sdk';
import { LineService } from './line.service';
import { LineUserService } from './line-user.service';
import { PENDING_MESSAGE_BY_POSTBACK_DATA } from './rich-menu.constants';

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
        await this.refreshProfile(event);
        if (event.message.type === 'text' && event.replyToken) {
          await this.line.reply(event.replyToken, [
            { type: 'text', text: `You said: ${event.message.text}` },
          ]);
        }
        break;

      case 'postback': {
        await this.refreshProfile(event);
        if (!event.replyToken) {
          break;
        }
        // The TYPE_2 rich menu's three bottom buttons are shortcuts to pages that
        // do not exist yet, so they answer with a "still being built" message
        // keyed off the postback data (see rich-menu.constants.ts, which both this
        // file and scripts/setup-rich-menu.ts import so the tokens cannot drift).
        //
        // Unknown data gets a generic reply, never an echo of the payload: the old
        // `Received action: ${data}` handed the user an internal action token, which
        // is developer output leaking into a real conversation. Log it instead — an
        // unrecognised token means a rich menu is live that this build does not know
        // about, which is worth seeing server-side.
        const pending = PENDING_MESSAGE_BY_POSTBACK_DATA.get(
          event.postback.data,
        );
        if (!pending) {
          this.logger.warn(
            `Unrecognised postback data: '${event.postback.data}'`,
          );
        }
        await this.line.reply(event.replyToken, [
          {
            type: 'text',
            text: pending ?? 'ขออภัย ระบบไม่รู้จักคำสั่งนี้',
          },
        ]);
        break;
      }

      default:
        this.logger.debug(`Unhandled event type: ${event.type}`);
    }
  }

  private userIdOf(event: webhook.Event): string | undefined {
    return event.source?.type === 'user' ? event.source.userId : undefined;
  }

  /**
   * Keep a chat-only follower's stored LINE profile from going stale.
   *
   * LINE announces a rename with **no event at all**, so the only way to learn about one is to
   * look while the user happens to be talking to us. Anybody who opens the LIFF is refreshed for
   * free from their own ID token (`LineUserService.getStatus`); this covers the follower who only
   * ever uses the chat, and it costs a real `getProfile` call — hence the cooldown inside
   * `refreshProfileFromLine` rather than a fetch per message.
   *
   * ⚠️ NOT ON `follow`, which does the fuller `upsertOnFollow` (it also clears `deletedAt` and
   * moves `followedAt`), and NOT on `unfollow`, where refreshing the profile of somebody who just
   * left would be work in the wrong direction.
   *
   * ⚠️ IT NEVER THROWS AND NEVER BLOCKS THE REPLY'S CORRECTNESS. `handleEvents` already swallows
   * per-event failures so LINE does not retry the batch, and this is awaited only so the refresh
   * cannot outlive the request that started it.
   */
  private async refreshProfile(event: webhook.Event): Promise<void> {
    const userId = this.userIdOf(event);
    if (userId) await this.users.refreshProfileFromLine(userId);
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
