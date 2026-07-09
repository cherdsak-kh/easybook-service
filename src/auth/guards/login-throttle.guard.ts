import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  LOGIN_IP_EMAIL_THROTTLER,
  loginIpEmailKey,
  loginIpKey,
  normaliseEmail,
  resolveIp,
} from '../login-throttle.key';

/**
 * The login rate limiter: 5 attempts / 15 min per (IP + email) **and** 20 / 15 min per IP.
 * The second limit is what stops an attacker spraying one password across many emails.
 *
 * Only `getTracker` and `generateKey` are overridden. `handleRequest` is not — that is what
 * throws `429` and sets the rate-limit headers, and `ThrottlerGuard` still owns the algorithm.
 *
 * The guard runs before the handler, so a rate-limited request never reaches the credential
 * check: "correct password but rate limited → 429" holds by construction (AC-19).
 */
@Injectable()
export class LoginThrottleGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(resolveIp(req as Request));
  }

  protected generateKey(
    context: ExecutionContext,
    _suffix: string,
    name: string,
  ): string {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = resolveIp(req);
    // Safe: Nest's body parser is registered during `NestFactory.create`, i.e. ahead of every
    // `app.use()` in main.ts and ahead of the router.
    const email = normaliseEmail(
      (req.body as { email?: unknown } | undefined)?.email,
    );

    return name === LOGIN_IP_EMAIL_THROTTLER
      ? loginIpEmailKey(ip, email)
      : loginIpKey(ip);
  }

  /**
   * `ThrottlerGuard` suffixes its own header with the throttler name (`Retry-After-login-ip`),
   * because both of our limits are *named*. AC-19 asks for a plain `Retry-After`, so set it here
   * — the one hook that fires exactly when a limit trips, and only then.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const res = context.switchToHttp().getResponse<Response>();
    res.header('Retry-After', String(throttlerLimitDetail.timeToBlockExpire));
    await super.throwThrottlingException(context, throttlerLimitDetail);
  }
}
