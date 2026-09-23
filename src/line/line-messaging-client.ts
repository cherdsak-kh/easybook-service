import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { messagingApi } from '@line/bot-sdk';

/**
 * DI token for the one LINE `MessagingApiClient` (`ANNOUNCE-API-2`, design S-1).
 *
 * The client is a provider so a test can replace it at the module boundary
 * (`overrideProvider(LINE_MESSAGING_CLIENT)`) and still run `LineService`'s real chunking, retry and
 * timeout code — whatever token `.env` holds.
 *
 * 🔴 NOT EXPORTED FROM `LineModule`. There is one client and one `LineService`; nothing else may
 * inject this.
 */
export const LINE_MESSAGING_CLIENT = Symbol('LINE_MESSAGING_CLIENT');

/**
 * `null` when `LINE_CHANNEL_ACCESS_TOKEN` is empty. "Configured" means `client !== null` and
 * nothing else — there is deliberately no second, token-derived flag.
 */
export const lineMessagingClientProvider: FactoryProvider<messagingApi.MessagingApiClient | null> =
  {
    provide: LINE_MESSAGING_CLIENT,
    useFactory: (config: ConfigService) => {
      const channelAccessToken = config.get<string>(
        'LINE_CHANNEL_ACCESS_TOKEN',
        '',
      );
      return channelAccessToken
        ? new messagingApi.MessagingApiClient({ channelAccessToken })
        : null;
    },
    inject: [ConfigService],
  };
