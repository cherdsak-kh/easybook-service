import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LoginEventStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SYSTEM_USER_NOT_FOUND } from '../../system-users/system-users.errors';
import {
  CANNOT_REVOKE_OWN_SESSIONS,
  canRevokeSessions,
  type Actor,
} from '../../system-users/system-users.policy';
import type { RevokeSessionsResponseDto } from './dto/session.dto';
import type { StaffSessionSummaryDto } from './dto/staff-session-summary.dto';
import { LoginLogService } from './login-log.service';
import { SessionTrackerService } from './session-tracker.service';
import { parseUserAgent } from './user-agent';

/**
 * E5 / E6 — a SUPER_ADMIN's view of, and force sign-out of, ANOTHER account's sessions (LOGIN-SESSIONS-1).
 * `@Roles(SUPER_ADMIN)` on the controller fires before any of this runs, so an ADMIN/VIEWER never reaches a
 * target lookup or a Redis call (AC-14).
 *
 * Provided and exported by `AuthModule` and injected into `SystemUsersController`. It does NOT depend on
 * `SystemUsersService`, so there is no class-level cycle.
 */
@Injectable()
export class StaffSessionsService {
  private readonly logger = new Logger(StaffSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracker: SessionTrackerService,
    private readonly loginLog: LoginLogService,
  ) {}

  /** E5. Self is allowed (the screen paints the section on your own row). */
  async summary(id: string): Promise<StaffSessionSummaryDto> {
    const target = await this.findLiveTarget(id);

    // A suspended account makes NO Redis call: its sessions authenticate nothing, so the honest count is 0.
    const [activeSessionCount, lastSuccess, lastForce] = await Promise.all([
      target.isActive
        ? this.tracker.list(id).then((sessions) => sessions.length)
        : Promise.resolve(0),
      this.loginLog.latest(id, LoginEventStatus.SUCCESS),
      this.loginLog.latest(id, LoginEventStatus.FORCE_REVOKED),
    ]);

    let lastLogin: StaffSessionSummaryDto['lastLogin'] = null;
    if (lastSuccess) {
      lastLogin = {
        at: lastSuccess.createdAt.toISOString(),
        device: parseUserAgent(lastSuccess.userAgent ?? ''),
        ipAddress: lastSuccess.ipAddress,
      };
    } else if (target.lastLoginAt) {
      // The login predates the 90-day history: the time is known, the device and IP are not.
      lastLogin = {
        at: target.lastLoginAt.toISOString(),
        device: null,
        ipAddress: null,
      };
    }

    return {
      activeSessionCount,
      lastLogin,
      // The actor is never selected, never returned.
      lastForceRevokedAt: lastForce?.createdAt.toISOString() ?? null,
    };
  }

  /**
   * E6. Ends every live session of the target, WITHOUT suspending it (`isActive` is untouched; the target
   * can sign in again with the same password). A suspended target is a valid target: ending its keys stops
   * one that was never hit during the suspension from coming back alive on reactivation.
   *
   * Not written to any activity source (AC-13). Exactly one `FORCE_REVOKED` row, and only when at least one
   * session was really ended: a 0-session call ended nothing, so a "forced out" row would be false.
   */
  async forceRevoke(
    actor: Actor,
    id: string,
  ): Promise<RevokeSessionsResponseDto> {
    const verdict = canRevokeSessions(actor, { id });
    if (!verdict.allowed) {
      // Self is a 400 by ruling (OQ-5); any other deny is the usual 403.
      throw verdict.reason === CANNOT_REVOKE_OWN_SESSIONS
        ? new BadRequestException(verdict.reason)
        : new ForbiddenException(verdict.reason);
    }

    await this.findLiveTarget(id);

    // A Redis failure here is a 503 and, because it throws first, no FORCE_REVOKED row is written.
    const revoked = await this.tracker.revokeAll(id);

    if (revoked >= 1) {
      try {
        await this.loginLog.recordForceRevoked(id, actor.id);
      } catch (error) {
        // The security action already happened. Answering failure would show the false "nothing was revoked".
        this.logger.error(
          `Could not record a force sign-out. actor=${actor.id} target=${id} reason=${
            error instanceof Error ? error.name : 'unknown'
          }`,
        );
      }
    }
    this.logger.log(
      `Force sign-out. actor=${actor.id} target=${id} revoked=${revoked}`,
    );
    return { revoked };
  }

  /** Unknown and soft-deleted are the same 404. */
  private async findLiveTarget(id: string): Promise<{
    id: string;
    isActive: boolean;
    lastLoginAt: Date | null;
  }> {
    const target = await this.prisma.systemUser.findUnique({
      where: { id },
      select: { id: true, isActive: true, deletedAt: true, lastLoginAt: true },
    });
    if (!target || target.deletedAt !== null) {
      throw new NotFoundException(SYSTEM_USER_NOT_FOUND);
    }
    return target;
  }
}
