import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateSignature } from '@line/bot-sdk';
import type { Request } from 'express';

/**
 * Verifies the `x-line-signature` header against the raw request body using the
 * channel secret (HMAC-SHA256). Requires `rawBody: true` on the Nest app.
 */
@Injectable()
export class LineSignatureGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    const secret = this.config.get<string>('LINE_CHANNEL_SECRET', '');
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
