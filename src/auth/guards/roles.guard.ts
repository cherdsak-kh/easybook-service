import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SystemRole } from '@prisma/client';
import { INSUFFICIENT_ROLE } from '../../system-users/system-users.policy';
import type { RequestWithSystemUser } from '../auth.types';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * The coarse role gate, and nothing else (DD-8).
 *
 * It reads `req.systemUser.role` — the **fresh DB read** performed by `SessionGuard`, never a
 * role cached in the session payload — so a mid-session demotion takes effect immediately.
 *
 * It deliberately does NOT re-check `deletedAt` / `isActive` (`SessionGuard` already rejected
 * those, and always runs first), and it deliberately does NOT hold the target-dependent matrix:
 * a guard runs before `ValidationPipe` and outside the write's transaction, so authorizing there
 * would mean reading raw `req.body` and a TOCTOU window on the target's role.
 *
 * Guard order is load-bearing: `@UseGuards(SessionGuard, RolesGuard)` executes left to right, so
 * "no session" is a `401` from `SessionGuard` and "wrong role" is a `403` from here.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<SystemRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestWithSystemUser>();
    const user = req.systemUser;

    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException(INSUFFICIENT_ROLE);
    }
    return true;
  }
}
