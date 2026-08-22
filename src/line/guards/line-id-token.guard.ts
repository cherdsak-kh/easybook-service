import {
  BadGatewayException,
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LineProfileClaims, RequestWithLineUserId } from '../line.types';

const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const LINE_ISSUER = 'https://access.line.me';
const VERIFY_TIMEOUT_MS = 3000;

/** Generic messages only — never echo the token or LINE's raw response. */
export const INVALID_LINE_CREDENTIALS = 'Invalid LINE credentials.';
export const LINE_VERIFICATION_UNAVAILABLE = 'LINE verification unavailable.';

/** The decoded ID-token payload LINE returns from the verify endpoint (fields we rely on). */
interface LineIdTokenPayload {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  /** Present only when the token was minted with the `profile` scope. Display data, not identity. */
  name?: unknown;
  picture?: unknown;
}

/**
 * The display half of the payload, kept apart from the identity half on purpose.
 *
 * ⚠️ ONLY NON-EMPTY STRINGS SURVIVE, and every other shape becomes absent rather than `null`. The
 * consumer treats absent as "no news" and would treat `null` as "the user cleared it" — so letting
 * a missing claim through as `null` would wipe a follower's stored name the first time a LIFF app
 * without the `profile` scope called us. `''` is folded into absent for the same reason: a blank
 * display name is not something LINE lets anyone actually have.
 *
 * These claims are NOT re-validated against anything, and do not need to be: they arrive on the
 * same LINE-signed payload the `sub` does, and they are written to display fields that no
 * authorization decision reads.
 */
function profileClaimsOf(payload: LineIdTokenPayload): LineProfileClaims {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return { displayName: str(payload.name), pictureUrl: str(payload.picture) };
}

/**
 * Authenticates a LINE end-user (LIFF client) by verifying the `Authorization: Bearer <id_token>`
 * against the **LINE Login channel** (`LINE_LOGIN_CHANNEL_ID`), which is a DIFFERENT channel from
 * the Messaging API one (`LINE_CHANNEL_ACCESS_TOKEN`/`_SECRET`). See design §2.
 *
 * Security invariant (LINK-LINE-1): the caller's identity is the **verified `sub`** attached to
 * `req.lineUserId`. Handlers must never accept a `lineUserId`/`U…` value from the body/params/query.
 *
 * Error mapping (design §2.2):
 *   - missing/malformed header, empty token, LINE 4xx, or a failed payload re-check → 401
 *   - LINE verify unreachable / timeout / 5xx / non-JSON body → 502 (retryable, NOT 401)
 *   - `LINE_LOGIN_CHANNEL_ID` unset at runtime → 500 (config defect)
 */
@Injectable()
export class LineIdTokenGuard implements CanActivate {
  private readonly logger = new Logger(LineIdTokenGuard.name);

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithLineUserId>();

    const token = this.extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new UnauthorizedException(INVALID_LINE_CREDENTIALS);
    }

    const channelId = this.config.get<string>('LINE_LOGIN_CHANNEL_ID', '');
    if (!channelId) {
      // A missing channel id is a deploy defect, never a client error — never a 401.
      this.logger.error(
        'LINE_LOGIN_CHANNEL_ID is not set — cannot verify LINE ID tokens.',
      );
      throw new InternalServerErrorException(
        'LINE authentication is not configured.',
      );
    }

    const payload = await this.verify(token, channelId);

    // Defence-in-depth re-checks on the returned payload (LINE already validated signature + expiry).
    if (
      payload.iss !== LINE_ISSUER ||
      payload.aud !== channelId ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.exp !== 'number' ||
      payload.exp * 1000 <= Date.now()
    ) {
      throw new UnauthorizedException(INVALID_LINE_CREDENTIALS);
    }

    // Identity comes ONLY from the verified `sub`.
    req.lineUserId = payload.sub;
    req.lineProfile = profileClaimsOf(payload);
    return true;
  }

  /** Returns the bearer token, or `null` for a missing/malformed `Authorization` header. */
  private extractBearerToken(header: string | undefined): string | null {
    if (typeof header !== 'string') return null;
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Calls LINE's verify endpoint. Uses POST form-encoding (design §2.1) to keep the token out of
   * any URL/access log. A network/timeout/5xx/non-JSON fault is a retryable 502; a 4xx is a 401.
   */
  private async verify(
    token: string,
    channelId: string,
  ): Promise<LineIdTokenPayload> {
    let response: Response;
    try {
      response = await fetch(LINE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: token, client_id: channelId }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
    } catch (error) {
      // A network failure to LINE is NOT proof the token is invalid — 502 lets the client retry.
      this.logger.warn(
        `LINE verify unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(LINE_VERIFICATION_UNAVAILABLE);
    }

    if (response.status >= 500) {
      this.logger.warn(`LINE verify returned ${response.status}.`);
      throw new BadGatewayException(LINE_VERIFICATION_UNAVAILABLE);
    }

    if (!response.ok) {
      // 4xx: LINE rejected the token (invalid / expired / wrong-aud).
      throw new UnauthorizedException(INVALID_LINE_CREDENTIALS);
    }

    try {
      return (await response.json()) as LineIdTokenPayload;
    } catch {
      // 200 with a non-JSON body is an upstream fault — retryable, not a client error.
      throw new BadGatewayException(LINE_VERIFICATION_UNAVAILABLE);
    }
  }
}
