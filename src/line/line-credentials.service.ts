import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LineService } from './line.service';

/** `AppSetting` keys for the three runtime-editable LINE credentials (`INTEGRATIONS-API-1`). */
export const LINE_SETTING_KEYS = {
  channelId: 'line.channel_id',
  channelSecret: 'line.channel_secret',
  channelAccessToken: 'line.channel_access_token',
} as const;

const DESCRIPTIONS: Record<keyof typeof LINE_SETTING_KEYS, string> = {
  channelId:
    'LINE Messaging API channel ID (10 digits). Set from การเชื่อมต่อระบบ.',
  channelSecret:
    'LINE channel secret — verifies webhook signatures. Overrides LINE_CHANNEL_SECRET. PLAINTEXT.',
  channelAccessToken:
    'LINE channel access token — every Messaging API call. Overrides LINE_CHANNEL_ACCESS_TOKEN. PLAINTEXT.',
};

export interface LineCredentialsUpdate {
  channelId?: string;
  channelSecret?: string;
  channelAccessToken?: string;
}

/** `2006123442` → `2006••••42`. Short values are returned whole — there is nothing to hide in them. */
export function maskChannelId(id: string): string {
  return id.length > 6 ? `${id.slice(0, 4)}••••${id.slice(-2)}` : id;
}

/**
 * The LINE channel credentials the process is RUNNING with, and the only writer of them.
 *
 * Precedence: an `AppSetting` row (saved by a SUPER_ADMIN on การเชื่อมต่อระบบ) wins over the env
 * var. The Channel ID has no env var — it exists only once someone saves it.
 *
 * 🔴 STORED IN PLAINTEXT (plan D-3). The secret and token are never returned by any endpoint — the
 * API says `configured` and a masked Channel ID, nothing more — but anyone with database read access
 * can read them. Encryption at rest needs a key-management decision and is a tracked follow-up.
 *
 * 🔴 IGNORED UNDER `NODE_ENV=test` (plan D-4). The e2e suites run against the dev database and fake
 * the Messaging client at the DI boundary. If a token saved through the UI were applied at boot, it
 * would REPLACE that fake with a real client, and `announcements-send` multicasts. Under test the env
 * values stand, exactly as before this service existed. `update()` still works (a unit spec calls it),
 * and the e2e never sends a token.
 */
@Injectable()
export class LineCredentialsService implements OnModuleInit {
  private readonly logger = new Logger(LineCredentialsService.name);
  private channelId: string | null = null;
  private secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('LINE_CHANNEL_SECRET', '');
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const rows = await this.prisma.appSetting.findMany({
        where: { key: { in: Object.values(LINE_SETTING_KEYS) } },
      });
      const value = (key: string) =>
        rows.find((r) => r.key === key)?.value.trim() || null;

      this.channelId = value(LINE_SETTING_KEYS.channelId);
      const secret = value(LINE_SETTING_KEYS.channelSecret);
      if (secret) this.secret = secret;
      const token = value(LINE_SETTING_KEYS.channelAccessToken);
      if (token) this.line.useAccessToken(token);
    } catch (err) {
      // A settings read must not stop the service booting — the env values keep working.
      this.logger.error(
        `Could not load stored LINE credentials; keeping env values (${(err as Error).name}).`,
      );
    }
  }

  /** The secret webhook signatures are verified with. Read per request by `LineSignatureGuard`. */
  channelSecret(): string {
    return this.secret;
  }

  maskedChannelId(): string | null {
    return this.channelId ? maskChannelId(this.channelId) : null;
  }

  isConfigured(): boolean {
    return this.line.isConfigured();
  }

  /**
   * Persist the given fields (one transaction), then apply them to the running process. Fields left
   * out are untouched. The DTO has already validated shape; this trusts it.
   */
  async update(input: LineCredentialsUpdate): Promise<void> {
    const entries = (
      Object.keys(LINE_SETTING_KEYS) as Array<keyof typeof LINE_SETTING_KEYS>
    ).filter((k) => input[k] !== undefined);

    await this.prisma.$transaction(
      entries.map((k) =>
        this.prisma.appSetting.upsert({
          where: { key: LINE_SETTING_KEYS[k] },
          create: {
            key: LINE_SETTING_KEYS[k],
            value: input[k]!,
            description: DESCRIPTIONS[k],
          },
          update: { value: input[k]! },
        }),
      ),
    );

    if (input.channelId !== undefined) this.channelId = input.channelId;
    if (input.channelSecret !== undefined) this.secret = input.channelSecret;
    if (input.channelAccessToken !== undefined) {
      this.line.useAccessToken(input.channelAccessToken);
    }
    // Field NAMES only — never a value.
    this.logger.log(`LINE credentials updated: ${entries.join(', ')}`);
  }
}
