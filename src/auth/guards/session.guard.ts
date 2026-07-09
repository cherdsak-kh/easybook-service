import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { destroySessionQuietly } from '../../session/session.util';
import { PUBLIC_FIELDS } from '../../system-users/system-users.fields';
import {
  AUTHENTICATION_REQUIRED,
  SESSION_ABSOLUTE_MAX_AGE_MS,
} from '../auth.constants';
import type { RequestWithSystemUser } from '../auth.types';

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
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

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

    req.systemUser = publicUser;
    return true;
  }
}
