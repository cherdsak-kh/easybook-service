import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { destroySessionQuietly } from '../../session/session.util';
import {
  AUTHENTICATION_REQUIRED,
  MUST_CHANGE_PASSWORD,
} from '../auth.constants';
import type { RequestWithSystemUser } from '../auth.types';
import { ALLOW_PASSWORD_CHANGE_GATE } from '../decorators/allow-password-change-gate.decorator';
import { resolveSessionUser } from '../session-user.resolver';

/**
 * Cookie-session authentication.
 *
 * D-9: the `SystemUser` is re-read from the database on **every** authenticated request, so a
 * deleted, suspended, or demoted user loses access on their next request rather than at session
 * expiry. That per-request indexed PK read is what makes session-revocation machinery — a
 * token-version column, a Redis `userId → sessionIds` index, a revocation list, a scan of the
 * session keyspace — unnecessary, and it is why none of it exists.
 *
 * `deletedAt` is **selected in order to be checked, then stripped**. A soft-deleted user is
 * normally still `isActive: true`, so checking `isActive` alone would authenticate a deleted
 * account holding a live cookie; and leaving `deletedAt` on `req.systemUser` would leak it
 * straight into `GET /auth/system/me`'s response body.
 *
 * **The forced-reset gate lives here too (AC-B8)**, deliberately:
 *   - It reuses the row this guard ALREADY read (`mustChangePassword` rides along in
 *     `PUBLIC_FIELDS`) — zero extra queries, and no second place that can drift from this guard's
 *     view of the user.
 *   - A *global* guard cannot work: globals run BEFORE controller-level guards, so it would find
 *     `req.systemUser` undefined and would have to issue its own DB read. A *non-global* second
 *     guard would have to be remembered on every future controller — the exact omission that
 *     becomes a hole.
 *
 * Order is load-bearing: `deletedAt`/`isActive` are 401s that DESTROY the session and fire FIRST, so
 * a suspended or soft-deleted user never reaches the reset screen. `mustChangePassword` is a
 * CREDENTIAL state, not a fourth lifecycle state: the session is KEPT and the answer is 403.
 *
 * The lifecycle decision itself now lives in `resolveSessionUser` so the WebSocket handshake can
 * reuse it verbatim instead of growing a second auth path. This guard keeps everything that is
 * HTTP-specific and unchanged: the session destruction on the three 401 paths, the `Reflector`
 * gate, and the 403. `session.guard.spec.ts` passes unmodified — that is the contract of the
 * extraction, not a coincidence.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithSystemUser>();

    const resolution = await resolveSessionUser(this.prisma, req.session);

    if (!resolution.ok) {
      // `NO_SESSION` is the one 401 that does NOT destroy: there is nothing to destroy, and
      // `req.session` may not exist at all. The other three (expired / user gone / revoked) each
      // leave a worthless Redis key behind, so they are cleaned up exactly as before.
      if (resolution.reason !== 'NO_SESSION') {
        await destroySessionQuietly(req);
      }
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    // Already stripped of `deletedAt` by the resolver, so it provably cannot reach
    // `req.systemUser` and therefore `GET /auth/system/me`'s response body.
    const publicUser = resolution.user;

    // The forced-reset gate. Deny by default; opt out with @AllowPasswordChangeGate(). The session
    // survives — this is a credential state, not a lifecycle failure — so the caller can still reach
    // the three exempt doors (logout / GET me / POST password) and change their password.
    if (
      publicUser.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_GATE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      throw new ForbiddenException(MUST_CHANGE_PASSWORD);
    }

    req.systemUser = publicUser;
    return true;
  }
}
