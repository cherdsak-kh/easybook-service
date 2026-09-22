import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { messagingApi } from '@line/bot-sdk';
import {
  classifyLineError,
  LineCallError,
  withTimeout,
  type LineErrorKind,
} from './line-call-error';
import { LINE_MESSAGING_CLIENT } from './line-messaging-client';
import { lineRetryKey } from './line-retry-key';
import {
  LINE_BOT_INFO_TIMEOUT_MS,
  LINE_CALL_TIMEOUT_MS,
  LINE_MULTICAST_MAX_MESSAGES,
  LINE_MULTICAST_MAX_RECIPIENTS,
} from './line.constants';
import {
  buildDecisionCard,
  buildReminderCard,
  type DecisionCardOptions,
  type ReminderCardOptions,
} from './notification-cards';

/** The OA's identity as the admin screen shows it (D-G). `userId` / `premiumId` are dropped. */
export interface LineBotInfo {
  basicId: string;
  displayName: string;
  pictureUrl: string | null;
  chatMode: 'chat' | 'bot';
  markAsReadMode: 'auto' | 'manual';
}

/**
 * The OA's monthly push quota (`INTEGRATIONS-API-1`). `total` is `null` when LINE reports no target
 * limit (`type: none`); `used` is this month's consumption so far. Reading it costs no quota.
 */
export interface LineMessageQuota {
  total: number | null;
  used: number;
}

/** Why a multicast stopped. Never `ALREADY_ACCEPTED` — that one counts as accepted. */
export interface MulticastFailure {
  chunkIndex: number;
  kind: Exclude<LineErrorKind, 'ALREADY_ACCEPTED'>;
  status: number | null;
}

/** What {@link LineService.multicast} did. It never throws for a LINE failure — it reports one. */
export interface MulticastOutcome {
  /** Distinct recipients after de-duplication. */
  targetedCount: number;
  /** Recipients in chunks LINE accepted — 200, or 409 on the retry key (D-E). Not a delivered count. */
  acceptedCount: number;
  /** HTTP attempts made, retries included — for tests and logs. */
  requestCount: number;
  /** `null` when every chunk was accepted. */
  failure: MulticastFailure | null;
}

/**
 * Thin wrapper over the LINE Messaging API SDK: reply/push/multicast messaging, bot info, and
 * rich-menu management.
 *
 * The Messaging client is INJECTED (`LINE_MESSAGING_CLIENT`, design S-1) and is `null` when
 * `LINE_CHANNEL_ACCESS_TOKEN` is empty: every call then rejects at once with a `NOT_CONFIGURED`
 * {@link LineCallError} instead of taking a 401 round trip. The blob client (rich-menu images) is
 * still built here from config.
 *
 * ⚠️ THE CLIENT CAN BE REPLACED AT RUNTIME (`INTEGRATIONS-API-1`): a SUPER_ADMIN saving a new
 * channel access token calls {@link useAccessToken} through `LineCredentialsService`. The field is
 * still named `client` on purpose — the e2e suites read it by that name (`clientHeldBy`) to refuse to
 * run unless their fake is the one wired in.
 */
@Injectable()
export class LineService {
  private readonly logger = new Logger(LineService.name);
  private client: messagingApi.MessagingApiClient | null;
  private blobClient: messagingApi.MessagingApiBlobClient;

  constructor(
    config: ConfigService,
    @Inject(LINE_MESSAGING_CLIENT)
    client: messagingApi.MessagingApiClient | null,
  ) {
    this.client = client;
    if (client === null) {
      this.logger.warn(
        'LINE_CHANNEL_ACCESS_TOKEN is not set — messaging/rich-menu calls will fail until configured.',
      );
    }
    this.blobClient = new messagingApi.MessagingApiBlobClient({
      channelAccessToken: config.get<string>('LINE_CHANNEL_ACCESS_TOKEN', ''),
    });
  }

  /** Whether a Messaging client is wired in — "configured" means exactly this, and nothing else. */
  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Swap in a new channel access token without a restart. An empty token leaves NO client, so every
   * call rejects `NOT_CONFIGURED` — the same state as an empty `LINE_CHANNEL_ACCESS_TOKEN` at boot.
   *
   * 🔴 Only `LineCredentialsService` calls this, and it never does under `NODE_ENV=test` from stored
   * rows (see there): a real client silently replacing an e2e fake would make those suites send.
   */
  useAccessToken(channelAccessToken: string): void {
    this.client = channelAccessToken
      ? new messagingApi.MessagingApiClient({ channelAccessToken })
      : null;
    this.blobClient = new messagingApi.MessagingApiBlobClient({
      channelAccessToken,
    });
    this.logger.log(
      channelAccessToken
        ? 'LINE channel access token replaced at runtime.'
        : 'LINE channel access token cleared at runtime — messaging is now NOT_CONFIGURED.',
    );
  }

  /** The client, or a `NOT_CONFIGURED` rejection. Every method below is `async`, so it never throws synchronously. */
  private requireClient(): messagingApi.MessagingApiClient {
    if (this.client === null) throw new LineCallError('NOT_CONFIGURED', null);
    return this.client;
  }

  // --- Messaging ---------------------------------------------------------

  async reply(
    replyToken: string,
    messages: messagingApi.Message[],
  ): Promise<unknown> {
    return this.requireClient().replyMessage({ replyToken, messages });
  }

  async push(to: string, messages: messagingApi.Message[]): Promise<unknown> {
    return this.requireClient().pushMessage({ to, messages });
  }

  /**
   * Send the same messages to many users (`ANNOUNCE-API-2`, D-B, design §1.5).
   *
   * - `to` is de-duplicated and KEEPS THE CALLER'S ORDER (the announcements caller passes
   *   `LineUser.id` order), then split into consecutive chunks of ≤ 500, sent one after another.
   * - Each chunk carries `X-Line-Retry-Key = lineRetryKey(retryKeySeed, chunk)`.
   * - LINE's 409 on that key means "already accepted" and counts as accepted.
   * - A `TRANSIENT` failure (network, 5xx, per-call timeout) is retried ONCE, at once, with the SAME
   *   key. Anything else — or a second failure — stops the send: later chunks are not sent.
   * - Before every attempt, `deadlineAt` (epoch ms) is checked; past it, the send stops as
   *   `TRANSIENT` without calling LINE (design S-2).
   *
   * Never throws for a LINE failure — a partial send must be able to commit. It throws a plain `Error`
   * only for a programmer error (`messages.length` outside 1–5).
   *
   * 🔴 Logs carry chunk index, kind and status ONLY — never ids, keys or message content.
   */
  async multicast(
    to: readonly string[],
    messages: messagingApi.Message[],
    options: { retryKeySeed: string; deadlineAt?: number },
  ): Promise<MulticastOutcome> {
    if (messages.length < 1 || messages.length > LINE_MULTICAST_MAX_MESSAGES) {
      throw new Error(
        `multicast takes 1-${LINE_MULTICAST_MAX_MESSAGES} messages, got ${messages.length}.`,
      );
    }

    const ids = [...new Set(to)];
    const outcome: MulticastOutcome = {
      targetedCount: ids.length,
      acceptedCount: 0,
      requestCount: 0,
      failure: null,
    };
    if (ids.length === 0) return outcome;

    const client = this.client;
    if (client === null) {
      outcome.failure = { chunkIndex: 0, kind: 'NOT_CONFIGURED', status: null };
      return outcome;
    }

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += LINE_MULTICAST_MAX_RECIPIENTS) {
      chunks.push(ids.slice(i, i + LINE_MULTICAST_MAX_RECIPIENTS));
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const key = lineRetryKey(options.retryKeySeed, chunk);
      let failure: MulticastFailure | null = null;

      for (let attempt = 1; ; attempt++) {
        if (
          options.deadlineAt !== undefined &&
          Date.now() >= options.deadlineAt
        ) {
          failure = { chunkIndex: i, kind: 'TRANSIENT', status: null };
          break;
        }
        outcome.requestCount++;
        try {
          await withTimeout(
            client.multicast({ to: chunk, messages }, key),
            LINE_CALL_TIMEOUT_MS,
          );
          break;
        } catch (err) {
          const e = classifyLineError(err);
          if (e.kind === 'ALREADY_ACCEPTED') break;
          if (e.kind === 'TRANSIENT' && attempt < 2) continue;
          failure = { chunkIndex: i, kind: e.kind, status: e.status };
          break;
        }
      }

      if (failure !== null) {
        this.logger.warn(
          `LINE multicast chunk failed chunk=${i}/${chunks.length} kind=${failure.kind} status=${failure.status}`,
        );
        outcome.failure = failure;
        break;
      }
      outcome.acceptedCount += chunk.length;
    }

    this.logger.debug(
      `LINE multicast chunks=${chunks.length} requests=${outcome.requestCount} accepted=${outcome.acceptedCount} targeted=${outcome.targetedCount}`,
    );
    return outcome;
  }

  /**
   * The OA's identity (D-G). One call, time-boxed, NO retry and NO cache (D-I). Rejects only with a
   * classified {@link LineCallError}.
   */
  async getBotInfo(): Promise<LineBotInfo> {
    try {
      const info = await withTimeout(
        this.requireClient().getBotInfo(),
        LINE_BOT_INFO_TIMEOUT_MS,
      );
      return {
        basicId: info.basicId,
        displayName: info.displayName,
        pictureUrl: info.pictureUrl ?? null,
        chatMode: info.chatMode,
        markAsReadMode: info.markAsReadMode,
      };
    } catch (err) {
      throw classifyLineError(err);
    }
  }

  /**
   * The monthly push quota: `GET /v2/bot/message/quota` + `/v2/bot/message/quota/consumption`, in
   * parallel, each time-boxed like {@link getBotInfo}. Two READS — nothing is sent and no quota is
   * spent. Rejects only with a classified {@link LineCallError}.
   */
  async getMessageQuota(): Promise<LineMessageQuota> {
    try {
      const client = this.requireClient();
      const [quota, consumption] = await Promise.all([
        withTimeout(client.getMessageQuota(), LINE_BOT_INFO_TIMEOUT_MS),
        withTimeout(
          client.getMessageQuotaConsumption(),
          LINE_BOT_INFO_TIMEOUT_MS,
        ),
      ]);
      return {
        total:
          quota.type === 'limited' && typeof quota.value === 'number'
            ? quota.value
            : null,
        used: consumption.totalUsage,
      };
    } catch (err) {
      throw classifyLineError(err);
    }
  }

  /**
   * Push a booking Decisions & Lifecycle card (`CLIENT-NOTIFY-1`). Goes through {@link push}, so a
   * spy on `push` observes it. Rejects on a LINE failure; the caller decides whether that is fatal
   * (the booking notifier is fail-soft).
   *
   * @param to the LINE-side `U…` id (`LineUser.lineUserId`), NOT the cuid `LineUser.id`.
   */
  pushDecisionNotification(
    to: string,
    options: DecisionCardOptions,
  ): Promise<unknown> {
    return this.push(to, [buildDecisionCard(options)]);
  }

  /** Push a pre-usage reminder card (`CLIENT-NOTIFY-1`). Same contract as the decision push. */
  pushReminderNotification(
    to: string,
    options: ReminderCardOptions,
  ): Promise<unknown> {
    return this.push(to, [buildReminderCard(options)]);
  }

  async getProfile(userId: string): Promise<messagingApi.UserProfileResponse> {
    return this.requireClient().getProfile(userId);
  }

  // --- Rich menu management ---------------------------------------------

  async createRichMenu(
    richMenu: messagingApi.RichMenuRequest,
  ): Promise<string> {
    const { richMenuId } = await this.requireClient().createRichMenu(richMenu);
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

  async setDefaultRichMenu(richMenuId: string): Promise<unknown> {
    return this.requireClient().setDefaultRichMenu(richMenuId);
  }

  async linkRichMenuToUser(
    userId: string,
    richMenuId: string,
  ): Promise<unknown> {
    return this.requireClient().linkRichMenuIdToUser(userId, richMenuId);
  }

  /**
   * Bulk variant of `linkRichMenuToUser`. LINE accepts at most 500 user ids per
   * call (`RICH_MENU_LINK_BATCH_SIZE`); batching is the caller's job.
   *
   * Used by `scripts/setup-rich-menu.ts` to re-link every existing user after the
   * menus are recreated — deleting a rich menu drops every per-user link to it, so
   * without this pass a menu refresh silently demotes approved users to the
   * account-level default menu.
   */
  async linkRichMenuToUsers(
    richMenuId: string,
    userIds: string[],
  ): Promise<unknown> {
    return this.requireClient().linkRichMenuIdToUsers({ richMenuId, userIds });
  }

  async listRichMenus(): Promise<messagingApi.RichMenuResponse[]> {
    const { richmenus } = await this.requireClient().getRichMenuList();
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

  async deleteRichMenu(richMenuId: string): Promise<unknown> {
    return this.requireClient().deleteRichMenu(richMenuId);
  }
}
