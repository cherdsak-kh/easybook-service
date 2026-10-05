import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SessionData } from 'express-session';
import type {
  RevokeSessionsResponseDto,
  SessionItemDto,
  SessionListResponseDto,
} from './dto/session.dto';
import { SESSION_HANDLE_PATTERN } from './session-handle';
import {
  CANNOT_REVOKE_CURRENT_SESSION,
  SESSION_NOT_FOUND,
} from './sessions.constants';
import {
  SessionTrackerService,
  type TrackedSession,
} from './session-tracker.service';
import { parseUserAgent } from './user-agent';

/** What the controller knows about the caller's own session. */
export interface CurrentSessionContext {
  userId: string;
  sid: string;
  session: Pick<SessionData, 'createdAt' | 'ip' | 'userAgent'> | undefined;
}

/**
 * E1–E3 — the signed-in user's OWN sessions (LOGIN-SESSIONS-1). Identity comes only from the session
 * (`userId`, `sid`), never from input, so there is no route by which one user can touch another's
 * sessions here (that is `StaffSessionsService`, SUPER_ADMIN only).
 */
@Injectable()
export class SessionsService {
  constructor(private readonly tracker: SessionTrackerService) {}

  /**
   * `current` is built from the request's own session, NOT from the index, so a session that predates this
   * feature (no `ip`/`userAgent`, in no index) still renders — as `ipAddress: null` and an `unknown` device.
   */
  async list(ctx: CurrentSessionContext): Promise<SessionListResponseDto> {
    const now = Date.now();
    const tracked = await this.tracker.list(ctx.userId);

    const current: SessionItemDto = {
      handle: this.tracker.handleOf(ctx.sid),
      isCurrent: true,
      device: parseUserAgent(ctx.session?.userAgent),
      ipAddress: ctx.session?.ip ?? null,
      loginAt: new Date(ctx.session?.createdAt ?? now).toISOString(),
      lastActiveAt: new Date(now).toISOString(),
    };

    const others = tracked
      .filter((s) => s.sid !== ctx.sid)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.loginAt - a.loginAt)
      .map((s) => this.toItem(s));

    return { current, others };
  }

  /** E2. Idempotent: nothing else live → `{ revoked: 0 }`. The current session is never touched. */
  async revokeOthers(
    ctx: CurrentSessionContext,
  ): Promise<RevokeSessionsResponseDto> {
    const revoked = await this.tracker.revokeAll(ctx.userId, {
      except: ctx.sid,
    });
    return { revoked };
  }

  /**
   * E3. Order of checks is the contract:
   *  1. the caller's own current handle → 400;
   *  2. anything that cannot be a handle → 404;
   *  3. a handle that is not among the CALLER'S OWN live sessions → the same 404.
   * Another user's handle, an unknown one, a malformed one and an already-revoked one therefore take the
   * same path and answer byte-identically (AC-7).
   */
  async revokeOne(
    ctx: CurrentSessionContext,
    handle: string,
  ): Promise<RevokeSessionsResponseDto> {
    if (handle === this.tracker.handleOf(ctx.sid)) {
      throw new BadRequestException(CANNOT_REVOKE_CURRENT_SESSION);
    }
    if (!SESSION_HANDLE_PATTERN.test(handle)) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }

    const target = await this.tracker.resolveHandle(ctx.userId, handle);
    if (!target) throw new NotFoundException(SESSION_NOT_FOUND);

    // The key can expire between the read and this write; `false` then means "already gone".
    if (!(await this.tracker.revokeOne(ctx.userId, target.sid))) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }
    return { revoked: 1 };
  }

  private toItem(s: TrackedSession): SessionItemDto {
    return {
      handle: s.handle,
      isCurrent: false,
      device: parseUserAgent(s.userAgent),
      ipAddress: s.ip,
      loginAt: new Date(s.loginAt).toISOString(),
      lastActiveAt: new Date(s.lastActiveAt).toISOString(),
    };
  }
}
