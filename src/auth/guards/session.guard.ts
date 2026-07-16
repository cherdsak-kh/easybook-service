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
import { PUBLIC_FIELDS } from '../../system-users/system-users.fields';
import {
  AUTHENTICATION_REQUIRED,
  MUST_CHANGE_PASSWORD,
  SESSION_ABSOLUTE_MAX_AGE_MS,
} from '../auth.constants';
import type { RequestWithSystemUser } from '../auth.types';
import { ALLOW_PASSWORD_CHANGE_GATE } from '../decorators/allow-password-change-gate.decorator';

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
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithSystemUser>();

    const systemUserId = req.session?.systemUserId;
    if (!systemUserId) {
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    // Absolute cap, independent of the rolling idle window.
    if (
      Date.now() - (req.session.createdAt ?? 0) >
      SESSION_ABSOLUTE_MAX_AGE_MS
    ) {
      await destroySessionQuietly(req);
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    const user = await this.prisma.systemUser.findUnique({
      where: { id: systemUserId },
      select: { ...PUBLIC_FIELDS, deletedAt: true },
    });

    if (!user) {
      await destroySessionQuietly(req);
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

    // `deletedAt` is destructured out here and nowhere else: it is selected ONLY so it can be
    // checked, and `publicUser` — the object that reaches `req.systemUser` and therefore
    // `GET /auth/system/me`'s response body — provably cannot carry it.
    const { deletedAt, ...publicUser } = user;

    // Both flags, independently. A soft-deleted user is typically still `isActive: true`, so
    // checking `isActive` alone would authenticate a deleted account holding a live cookie.
    if (deletedAt !== null || !publicUser.isActive) {
      await destroySessionQuietly(req);
      throw new UnauthorizedException(AUTHENTICATION_REQUIRED);
    }

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
