import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import {
  REDIS_CLIENT,
  SESSION_KEY_PREFIX,
  sessionIndexKey,
} from '../../redis/redis.constants';
import { sessionTtlSeconds } from '../../session/session.middleware';
import { SESSION_STORE_UNAVAILABLE } from '../../session/session.util';
import { SESSION_ABSOLUTE_MAX_AGE_MS } from '../auth.constants';
import { deriveHandleKey, sessionHandle } from './session-handle';
import { SESSION_INDEX_TTL_SECONDS } from './sessions.constants';

/** One live session of one user, as the tracker reports it. `sid` is a bearer secret: never log or return it. */
export interface TrackedSession {
  sid: string;
  handle: string;
  /** Epoch ms — `session.createdAt`. */
  loginAt: number;
  /** Epoch ms, derived from the idle TTL (±1 s). */
  lastActiveAt: number;
  ip: string | null;
  userAgent: string | null;
}

/** The session a login replaced, so its index entry is removed in the same MULTI. */
export interface PreviousSession {
  userId: string;
  sid: string;
}

type Classified =
  | { kind: 'live'; session: TrackedSession }
  /** The key exists, belongs to this user, and is past the 24h cap: dead, but only the TTL removes the key. */
  | { kind: 'pastCap' }
  /** The key names ANOTHER user. Never `DEL`ed — only removed from this index. */
  | { kind: 'foreign' }
  /** Missing key, or unparseable JSON. */
  | { kind: 'missing' };

type PipelineResult = Array<[Error | null, unknown]> | null;

/**
 * LOGIN-SESSIONS-1 — the per-user session index (`eb:user-sessions:<id>`, a Set of raw sids) and every
 * revocation built on it. Talks to the RAW `REDIS_CLIENT`, never `RedisService`: that one auto-prefixes
 * `eb:cache:` and its write path is a `DEL`.
 *
 * ── "LIVE" (one definition, used by every reader) ──
 * A member `sid` of user `U` is live iff `eb:sess:<sid>` exists, parses as JSON, names `U`, and was created
 * within `SESSION_ABSOLUTE_MAX_AGE_MS`. Everything else is stale and is `SREM`ed by the read that found it
 * (prune-on-read). `isActive`/`deletedAt` are NOT part of "live": they are `SessionGuard`'s business.
 *
 * ── Fail modes (R-12) ──
 * Required steps (reads, the revoke `EXEC`) map any Redis rejection to a 503 with the same message as
 * `session.util.ts`. `track`/`untrack` are best-effort and never throw — a login or logout must not fail
 * because only the index write failed; prune-on-read heals the index.
 *
 * ⚠️ Members are bearer secrets. Nothing here logs a sid or a handle, and nothing may `KEYS`/`SCAN` this family.
 * ⚠️ `SessionGuard` deliberately does NOT use this service (it must depend only on globals — five modules
 * use it without importing `AuthModule`). The keys it destroys are pruned on the next read instead.
 */
@Injectable()
export class SessionTrackerService {
  private readonly logger = new Logger(SessionTrackerService.name);
  private readonly handleKey: Buffer;
  private readonly idleTtlMs: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.handleKey = deriveHandleKey(
      config.getOrThrow<string>('SESSION_SECRET'),
    );
    this.idleTtlMs = sessionTtlSeconds(config) * 1000;
  }

  /** The opaque, stable handle of a session id. */
  handleOf(sid: string): string {
    return sessionHandle(this.handleKey, sid);
  }

  /**
   * Login: `MULTI [SREM prevIdx prevSid]? SADD idx sid; EXPIRE idx 86460`. Best-effort — never throws.
   * A failure here leaves a session that is valid but not revocable until it expires (R-12, accepted).
   */
  async track(
    userId: string,
    sid: string,
    prev?: PreviousSession | null,
  ): Promise<void> {
    try {
      const multi = this.redis.multi();
      if (prev) multi.srem(sessionIndexKey(prev.userId), prev.sid);
      multi
        .sadd(sessionIndexKey(userId), sid)
        .expire(sessionIndexKey(userId), SESSION_INDEX_TTL_SECONDS);
      this.assertNoCommandError(await multi.exec());
    } catch (error) {
      this.logger.warn(
        `Could not index a new session. user=${userId} reason=${this.reason(error)}`,
      );
    }
  }

  /** Logout: `SREM`. Best-effort — never throws. */
  async untrack(userId: string, sid: string): Promise<void> {
    try {
      await this.redis.srem(sessionIndexKey(userId), sid);
    } catch (error) {
      this.logger.warn(
        `Could not remove a session from the index. user=${userId} reason=${this.reason(error)}`,
      );
    }
  }

  /**
   * The user's live sessions, unsorted. Prunes every stale member with ONE `SREM`; a failed prune is a
   * warning and the response is still served. A Redis failure on the read itself is a 503.
   */
  async list(userId: string): Promise<TrackedSession[]> {
    const members = await this.readMembers(userId);
    const stale = members
      .filter((m) => m.classified.kind !== 'live')
      .map((m) => m.sid);
    if (stale.length > 0) {
      try {
        await this.redis.srem(sessionIndexKey(userId), ...stale);
      } catch (error) {
        this.logger.warn(
          `Could not prune the session index. user=${userId} reason=${this.reason(error)}`,
        );
      }
    }
    return members.flatMap((m) =>
      m.classified.kind === 'live' ? [m.classified.session] : [],
    );
  }

  /** Resolves a handle against the CALLER'S OWN live sessions only; `null` when none matches. */
  async resolveHandle(
    userId: string,
    handle: string,
  ): Promise<TrackedSession | null> {
    const sessions = await this.list(userId);
    return sessions.find((s) => s.handle === handle) ?? null;
  }

  /**
   * `MULTI DEL eb:sess:<sid>; SREM idx sid; EXEC`. Returns false when the key was already gone (it expired
   * between the read and this write), so the caller answers 404. Any Redis failure is a 503.
   */
  async revokeOne(userId: string, sid: string): Promise<boolean> {
    const results = await this.required(async () => {
      const multi = this.redis.multi();
      multi.del(`${SESSION_KEY_PREFIX}${sid}`);
      multi.srem(sessionIndexKey(userId), sid);
      return this.assertNoCommandError(await multi.exec());
    });
    return results[0][1] === 1;
  }

  /**
   * Ends every live session of the user (optionally sparing `except`, the caller's own). Two phases:
   * a read that classifies every member, then ONE `MULTI` — a `DEL` per own member, then a single `SREM` of
   * every member that was read. `revoked` counts the live members whose individual `DEL` returned 1, so it
   * is exact.
   *
   * The `MULTI` only `SREM`s what the read saw, so a login that landed in between survives (R-13, accepted).
   * A member whose JSON names another user is `SREM`ed but never `DEL`ed (defence in depth).
   * Any Redis failure on either phase is a 503 and nothing is reported revoked.
   */
  async revokeAll(
    userId: string,
    options: { except?: string } = {},
  ): Promise<number> {
    const members = (await this.readMembers(userId)).filter(
      (m) => m.sid !== options.except,
    );
    if (members.length === 0) return 0;

    // Own = live, or the user's own key that is merely past the cap. Both are deleted; only live counts.
    const toDelete = members.filter(
      (m) => m.classified.kind === 'live' || m.classified.kind === 'pastCap',
    );

    const results = await this.required(async () => {
      const multi = this.redis.multi();
      for (const m of toDelete) multi.del(`${SESSION_KEY_PREFIX}${m.sid}`);
      multi.srem(sessionIndexKey(userId), ...members.map((m) => m.sid));
      return this.assertNoCommandError(await multi.exec());
    });

    let revoked = 0;
    toDelete.forEach((m, i) => {
      if (m.classified.kind === 'live' && results[i][1] === 1) revoked += 1;
    });
    return revoked;
  }

  // ── internals ──

  /** `SMEMBERS`, then one pipeline of `GET` + `PTTL` per member, then classification. A failure is a 503. */
  private async readMembers(
    userId: string,
  ): Promise<Array<{ sid: string; classified: Classified }>> {
    return this.required(async () => {
      const sids = await this.redis.smembers(sessionIndexKey(userId));
      if (sids.length === 0) return [];

      const pipeline = this.redis.pipeline();
      for (const sid of sids) {
        pipeline.get(`${SESSION_KEY_PREFIX}${sid}`);
        pipeline.pttl(`${SESSION_KEY_PREFIX}${sid}`);
      }
      const replies = this.assertNoCommandError(await pipeline.exec());
      const now = Date.now();

      return sids.map((sid, i) => ({
        sid,
        classified: this.classify(
          userId,
          sid,
          replies[i * 2][1] as string | null,
          replies[i * 2 + 1][1] as number,
          now,
        ),
      }));
    });
  }

  private classify(
    userId: string,
    sid: string,
    raw: string | null,
    pttl: number,
    now: number,
  ): Classified {
    if (raw === null) return { kind: 'missing' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: 'missing' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { kind: 'missing' };
    }
    const data = parsed as {
      systemUserId?: unknown;
      createdAt?: unknown;
      ip?: unknown;
      userAgent?: unknown;
    };

    if (data.systemUserId !== userId) return { kind: 'foreign' };
    if (
      typeof data.createdAt !== 'number' ||
      now - data.createdAt > SESSION_ABSOLUTE_MAX_AGE_MS
    ) {
      return { kind: 'pastCap' };
    }

    const loginAt = data.createdAt;
    // `rolling: true` re-arms the key's TTL to the full idle window on every request, so the time elapsed
    // since the last request is `ttl - PTTL`. The stored JSON's cookie.expires is stale (F-2). A negative
    // PTTL (-1 no expiry, -2 missing) carries no information, so the session reports its login time.
    const idleMs = pttl >= 0 ? this.idleTtlMs - pttl : now - loginAt;
    const lastActiveAt = Math.min(Math.max(now - idleMs, loginAt), now);

    return {
      kind: 'live',
      session: {
        sid,
        handle: this.handleOf(sid),
        loginAt,
        lastActiveAt,
        ip: typeof data.ip === 'string' ? data.ip : null,
        userAgent: typeof data.userAgent === 'string' ? data.userAgent : null,
      },
    };
  }

  /** ioredis reports a failed command inside `exec()`'s result array rather than rejecting. */
  private assertNoCommandError(
    results: PipelineResult,
  ): Array<[Error | null, unknown]> {
    if (results === null) throw new Error('transaction aborted');
    for (const [error] of results) {
      if (error) throw error;
    }
    return results;
  }

  /** Runs a REQUIRED Redis step: any failure is logged (no ids) and surfaced as the standard 503. */
  private async required<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      this.logger.error(`Session index failure: ${this.reason(error)}`);
      throw new ServiceUnavailableException(SESSION_STORE_UNAVAILABLE);
    }
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
