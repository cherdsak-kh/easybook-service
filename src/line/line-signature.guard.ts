import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { validateSignature } from '@line/bot-sdk';
import type { Request } from 'express';
import { LineCredentialsService } from './line-credentials.service';

/**
 * Verifies the `x-line-signature` header against the raw request body using the
 * channel secret (HMAC-SHA256). Requires `rawBody: true` on the Nest app.
 *
 * The secret is read PER REQUEST from `LineCredentialsService` (`INTEGRATIONS-API-1`), so a secret a
 * SUPER_ADMIN saves takes effect on the very next webhook — no restart. Without a saved one it is
 * `LINE_CHANNEL_SECRET`, as before.
 */
@Injectable()
export class LineSignatureGuard implements CanActivate {
  constructor(private readonly credentials: LineCredentialsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    const secret = this.credentials.channelSecret();
    const signature = req.header('x-line-signature');
    const body = req.rawBody;

    if (!secret || !signature || !body) {
      throw new UnauthorizedException(
        'Missing LINE signature, raw body, or channel secret.',
      );
    }

    if (!validateSignature(body, secret, signature)) {
      throw new UnauthorizedException('Invalid LINE signature.');
    }

    return true;
  }
}
