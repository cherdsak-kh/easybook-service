import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SystemRole } from '@prisma/client';
import { SUPPORT_INCIDENT_SEQ_KEY, supportRateKey } from '../redis/cache-keys';
import { RedisService } from '../redis/redis.service';
import { sniffImageType, type AvatarImageType } from '../storage/image-sniff';
import type {
  SupportIncidentDto,
  SupportIncidentResponseDto,
} from './dto/support-incident.dto';
import { buildDiscordPayload } from './support-discord.payload';
import { SupportWebhookTransport } from './support-webhook.transport';
import {
  SUPPORT_ATTACHMENTS_TOO_LARGE_MSG,
  SUPPORT_CODE_OFFSET,
  SUPPORT_DISCORD_UPLOAD_BUDGET_BYTES,
  SUPPORT_FILE_TYPE_MSG,
  SUPPORT_NOT_CONFIGURED_MSG,
  SUPPORT_RATE_LIMIT,
  SUPPORT_RATE_LIMITED_MSG,
  SUPPORT_RATE_WINDOW_SECONDS,
  SUPPORT_RELAY_FAILED_MSG,
  SUPPORT_RELAY_TIMEOUT_MS,
  SUPPORT_WEBHOOK_ENV,
  type SupportErrorCode,
} from './support.constants';

/** A Nest exception class whose first argument becomes the response body when it is an object. */
type HttpExceptionClass = new (objectOrError?: unknown) => HttpException;

/**
 * The house `{ statusCode, error, message }` body plus a stable `code` (copied locally, as
 * `IntegrationsService` and `AnnouncementsService` each do).
 *
 * 🔴 NEVER pass `{ cause }` to these exceptions: `incident-redact.ts` walks the `cause` chain into
 * the Hub 6 stack, and a fetch error's cause can name the upstream.
 */
function codedError(
  Exception: HttpExceptionClass,
  code: SupportErrorCode,
  message: string,
): HttpException {
  const base = new Exception(message).getResponse() as Record<string, unknown>;
  return new Exception({ ...base, code });
}

/**
 * The slice of the session user the relay reads. `AuthenticatedSystemUser` satisfies it; name and phone
 * are optional so a missing one can never fail a report.
 *
 * 🔴 Revision 2 deliberately sends the reporter's name and phone to Discord (PO decision, spoiler-masked).
 * They must stay out of every log line and out of any exception, exactly like the webhook URL.
 */
export interface SupportReporter {
  id: string;
  role: SystemRole;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumber?: string | null;
}

const FILE_EXTENSION: Record<AvatarImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** `INC-<BE yyyyMMdd>-<HHmmss>` on the Bangkok clock. Only used when the Redis sequence is unavailable. */
export function fallbackIncidentCode(at: Date): string {
  const shifted = new Date(at.getTime() + 7 * 60 * 60 * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `INC-${p(shifted.getUTCFullYear() + 543, 4)}${p(shifted.getUTCMonth() + 1)}${p(shifted.getUTCDate())}` +
    `-${p(shifted.getUTCHours())}${p(shifted.getUTCMinutes())}${p(shifted.getUTCSeconds())}`
  );
}

/**
 * Relays an admin's incident report to the dev team's Discord webhook (`POST /system/support/incident`).
 * Nothing is persisted (D6). Check order is design §2.5: config → sniff → budget → rate limit → code →
 * relay → map result.
 *
 * 🔴 SECRET HYGIENE. The webhook URL is a credential. It is read per request, never stored in a field,
 * and nothing here logs or throws `error.message`, `error.cause`, the URL, Discord's response body or
 * any user text. The only log lines are the three in this file; every exception is a fresh coded
 * `HttpException` with a Thai message and no `cause`.
 */
@Injectable()
export class SupportRelayService {
  private readonly logger = new Logger(SupportRelayService.name);
  /** The "configured but invalid" warning fires once per process — never the value. */
  private warnedInvalid = false;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly transport: SupportWebhookTransport,
  ) {}

  async submit(
    user: SupportReporter,
    dto: SupportIncidentDto,
    files: Express.Multer.File[] = [],
  ): Promise<SupportIncidentResponseDto> {
    // 1. Config.
    const url = this.resolveWebhookUrl();
    if (!url) {
      throw codedError(
        ServiceUnavailableException,
        'SUPPORT_NOT_CONFIGURED',
        SUPPORT_NOT_CONFIGURED_MSG,
      );
    }

    // 2. Sniff. `mimetype` and `originalname` are ignored entirely; a 0-byte file sniffs to null.
    const sniffed: AvatarImageType[] = [];
    for (const file of files) {
      const type = sniffImageType(file.buffer);
      if (!type) {
        throw codedError(
          BadRequestException,
          'SUPPORT_FILE_TYPE_UNSUPPORTED',
          SUPPORT_FILE_TYPE_MSG,
        );
      }
      sniffed.push(type);
    }

    // 3. Budget (combined size, before any upload to Discord).
    const totalBytes = files.reduce((n, f) => n + f.buffer.length, 0);
    if (totalBytes > SUPPORT_DISCORD_UPLOAD_BUDGET_BYTES) {
      throw codedError(
        PayloadTooLargeException,
        'SUPPORT_ATTACHMENTS_TOO_LARGE',
        SUPPORT_ATTACHMENTS_TOO_LARGE_MSG,
      );
    }

    // 4. Rate limit. Fails OPEN: the support channel matters most during an outage.
    const count = await this.redis.incrementWindow(
      supportRateKey(user.id),
      SUPPORT_RATE_WINDOW_SECONDS,
    );
    if (count !== null && count > SUPPORT_RATE_LIMIT) {
      // Nest has no TooManyRequestsException; same house body as codedError.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: SUPPORT_RATE_LIMITED_MSG,
          code: 'SUPPORT_RATE_LIMITED' satisfies SupportErrorCode,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 5. Code + timestamp (one instant, used for the response and the message).
    const timestamp = new Date();
    const seq = await this.redis.incrementSequence(SUPPORT_INCIDENT_SEQ_KEY);
    const code =
      seq === null
        ? fallbackIncidentCode(timestamp)
        : `INC-${SUPPORT_CODE_OFFSET + seq}`;

    // 6. Relay.
    const filenames = sniffed.map(
      (type, i) => `screenshot-${i + 1}.${FILE_EXTENSION[type]}`,
    );
    // Name and phone come from the SESSION user (`SessionGuard`'s fresh DB read), never the request body.
    // A missing value degrades to a placeholder; it never fails the request.
    const reporterName =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || '—';
    const payload = buildDiscordPayload({
      code,
      category: dto.category,
      severity: dto.severity,
      role: user.role,
      reporterName,
      phoneNumber: user.phoneNumber ?? null,
      path: dto.path,
      description: dto.description,
      diagnostics: dto.diagnostics,
      timestamp,
      files: filenames.map((filename) => ({ filename })),
    });
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    files.forEach((file, i) => {
      form.append(
        `files[${i}]`,
        new Blob([new Uint8Array(file.buffer)], { type: sniffed[i] }),
        filenames[i],
      );
    });

    let status: number;
    try {
      status = await this.transport.post(
        url,
        form,
        AbortSignal.timeout(SUPPORT_RELAY_TIMEOUT_MS),
      );
    } catch (error) {
      // Never log or re-throw `error`: a fetch failure can embed the request URL in its message.
      const name = error instanceof Error ? error.name : '';
      const reason =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'timeout'
          : 'network';
      this.logger.warn(
        `Support relay failed. code=SUPPORT_RELAY_FAILED reason=${reason}`,
      );
      throw codedError(
        BadGatewayException,
        'SUPPORT_RELAY_FAILED',
        SUPPORT_RELAY_FAILED_MSG,
      );
    }

    // 7. Map the result.
    if (status >= 200 && status < 300) {
      this.logger.log(
        `Support incident relayed. code=${code} severity=${dto.severity} files=${files.length}`,
      );
      return { success: true, code, timestamp: timestamp.toISOString() };
    }

    // Discord 413 is the one upstream failure the user can fix (fewer/smaller images).
    if (status === 413) {
      this.logger.warn(
        `Support relay failed. code=SUPPORT_ATTACHMENTS_TOO_LARGE status=${status}`,
      );
      throw codedError(
        PayloadTooLargeException,
        'SUPPORT_ATTACHMENTS_TOO_LARGE',
        SUPPORT_ATTACHMENTS_TOO_LARGE_MSG,
      );
    }

    this.logger.warn(
      `Support relay failed. code=SUPPORT_RELAY_FAILED status=${status}`,
    );
    throw codedError(
      BadGatewayException,
      'SUPPORT_RELAY_FAILED',
      SUPPORT_RELAY_FAILED_MSG,
    );
  }

  /**
   * Read per request via `ConfigService` (never captured at boot). Unset/blank -> `null` silently; an
   * unparsable or non-https value -> `null` plus ONE per-process warning that names the variable only.
   * `wait=true` is set through `searchParams`, which keeps any existing query (e.g. `thread_id`).
   */
  private resolveWebhookUrl(): URL | null {
    const raw = this.config.get<string>(SUPPORT_WEBHOOK_ENV);
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length === 0) return null;

    let url: URL | null = null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:') url = parsed;
    } catch {
      url = null;
    }
    if (!url) {
      if (!this.warnedInvalid) {
        this.warnedInvalid = true;
        this.logger.warn(
          `Support relay disabled: ${SUPPORT_WEBHOOK_ENV} is not a valid https URL.`,
        );
      }
      return null;
    }
    url.searchParams.set('wait', 'true');
    return url;
  }
}
