import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketGateway, type OnGatewayInit } from '@nestjs/websockets';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';
import type { SessionData } from 'express-session';
import type { Redis } from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { SESSION_ABSOLUTE_MAX_AGE_MS } from '../auth/auth.constants';
import { resolveSystemUserById } from '../auth/session-user.resolver';
import type { AdminBookingRequestListItemDto } from '../bookings/dto/admin-booking-response.dto';
import type { LineUserResponseDto } from '../line/dto/line-user-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT, SESSION_KEY_PREFIX } from '../redis/redis.constants';
import { createSessionMiddleware } from '../session/session.middleware';
import {
  DEFAULT_WS_REVALIDATE_INTERVAL_MS,
  REALTIME_ADMIN_NAMESPACE,
  REALTIME_EVENTS,
  type RealtimeActor,
  SESSION_CLOSED_REASONS,
  WS_SWEEP_BUDGET_MS,
  type SessionClosedReason,
} from './realtime.constants';
import {
  createAuthenticateMiddleware,
  isRealtimeEligible,
  socketData,
  wrapExpressMiddleware,
  wrapSessionMiddleware,
} from './realtime.handshake';

/**
 * Resolves `WS_REVALIDATE_INTERVAL_MS`. Optional; an unparseable value falls back to the default
 * with a `warn`, following the `TRUST_PROXY_HOPS` precedent — a mis-set sweep period is an
 * operational nit, not a deploy-blocking secret defect, so it must not fail boot.
 */
export function resolveRevalidateIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_WS_REVALIDATE_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    new Logger(RealtimeGateway.name).warn(
      `Invalid WS_REVALIDATE_INTERVAL_MS="${raw}"; falling back to ${DEFAULT_WS_REVALIDATE_INTERVAL_MS}.`,
    );
    return DEFAULT_WS_REVALIDATE_INTERVAL_MS;
  }
  return parsed;
}

/**
 * The back-office realtime fan-out.
 *
 * **Zero `@SubscribeMessage` handlers, by design.** The surface is strictly server → client, which
 * is half the reason CSRF does not apply: there is no state a forged request could change. The
 * other half is that the handshake is a `GET` and `csrf-csrf` already ignores `GET` — no exemption
 * is added and `CSRF_EXEMPT_PATHS` is untouched. The socket-shaped version of that threat (CSWSH)
 * gets its own control in `SessionIoAdapter`'s `allowRequest`.
 *
 * **No rooms.** Every socket in `/admin` cleared the same `SUPER_ADMIN|ADMIN` gate as
 * `GET /line-users`, so namespace membership IS the authorization boundary and every socket is
 * entitled to every event.
 */
@WebSocketGateway({ namespace: REALTIME_ADMIN_NAMESPACE })
export class RealtimeGateway
  implements OnGatewayInit<Namespace>, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);

  /**
   * The `/admin` namespace, captured in `afterInit`. Undefined until then (and forever in a
   * socket-less unit test), which every emit path tolerates — see `emit`.
   */
  private namespace?: Namespace;

  /**
   * A read-only view of the session keyspace for the sweep. A second `RedisStore` instance over the
   * same client and the same `eb:sess:` prefix is benign: it reads the identical keys the handshake
   * middleware wrote nothing to. The gateway NEVER writes to Redis.
   */
  private store?: RedisStore;

  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Installs the handshake chain on the namespace.
   *
   * `createSessionMiddleware` is **re-invoked, not re-implemented** — same cookie name, same
   * `SESSION_SECRET`, same key prefix, same TTL, same store over the same shared client. There is
   * no place for the WS and HTTP views of a session to disagree, and Redis fails closed here for
   * free because that behaviour lives in `express-session` itself.
   */
  afterInit(namespace: Namespace): void {
    this.namespace = namespace;
    this.store = new RedisStore({
      client: this.redis,
      prefix: SESSION_KEY_PREFIX,
    });

    namespace.use(wrapExpressMiddleware(cookieParser()));
    namespace.use(
      wrapSessionMiddleware(createSessionMiddleware(this.config, this.redis)),
    );
    namespace.use(createAuthenticateMiddleware(this.prisma));

    this.startRevalidationSweep();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  // ───────────────────────────────── emit surface ─────────────────────────────────

  /**
   * Broadcasts a row that now exists (or re-exists) in the operator's list.
   *
   * ⚠️ `actor` is REQUIRED at the call site and nullable in value. Making it optional would let a
   * future emit site forget it and silently ship an event that says what changed but not who
   * changed it — which is the gap REALTIME-1 exists to close. `null` is a real answer: nobody
   * operated, a LINE user followed or edited their own registration.
   */
  emitLineUserCreated(
    dto: LineUserResponseDto,
    actor: RealtimeActor | null,
  ): void {
    this.emit(REALTIME_EVENTS.lineUserCreated, { user: dto, actor }, dto.id);
  }

  /** Broadcasts a row whose contents changed. */
  emitLineUserUpdated(
    dto: LineUserResponseDto,
    actor: RealtimeActor | null,
  ): void {
    this.emit(REALTIME_EVENTS.lineUserUpdated, { user: dto, actor }, dto.id);
  }

  /** Broadcasts a row that left the operator's list (unfollow → soft delete). */
  emitLineUserDeleted(id: string, actor: RealtimeActor | null): void {
    this.emit(REALTIME_EVENTS.lineUserDeleted, { id, actor }, id);
  }

  /**
   * Broadcasts a booking request that now exists in the approval queue.
   *
   * ⚠️ `actor` is REQUIRED at the call site and nullable in value, for the same reason as the
   * `lineUser*` pair: `null` is a real answer — a LINE user submitted it through LIFF, and no
   * operator did anything.
   *
   * ⚠️ THE DTO IS `AdminBookingRequestListItemDto` AND NOTHING ELSE, including on the paths that
   * already hold a richer detail DTO. The client's type is generated from this contract, so a
   * payload that carried a few extra detail fields would be a shape the generated client does not
   * describe — and one the next refresh would silently drop.
   */
  emitBookingRequestCreated(
    dto: AdminBookingRequestListItemDto,
    actor: RealtimeActor | null,
  ): void {
    this.emit(
      REALTIME_EVENTS.bookingRequestCreated,
      { booking: dto, actor },
      dto.id,
    );
  }

  /**
   * Broadcasts a booking request whose contents changed.
   *
   * 🔴 CALLED ONCE PER CHANGED ROW. An approval that auto-rejects two overlapping requests calls
   * this three times — once for the subject and once for each loser. See
   * `REALTIME_EVENTS.bookingRequestUpdated`.
   */
  emitBookingRequestUpdated(
    dto: AdminBookingRequestListItemDto,
    actor: RealtimeActor | null,
  ): void {
    this.emit(
      REALTIME_EVENTS.bookingRequestUpdated,
      { booking: dto, actor },
      dto.id,
    );
  }

  /**
   * Synchronous, `void`, and it NEVER throws — the same fail-soft discipline as
   * `notifyAccessChange`. The write has already committed by the time we get here, so a fan-out
   * failure (gateway not yet initialised, serialization error, transport down) is logged at `warn`
   * and swallowed. It must never roll back or fail an HTTP mutation.
   *
   * PII discipline: the log line carries the event name and `id=` only — never the DTO, never a
   * name or phone number.
   */
  private emit(event: string, payload: unknown, id: string): void {
    try {
      if (!this.namespace) {
        this.logger.warn(
          `Realtime emit skipped (gateway not initialised). event=${event} id=${id}`,
        );
        return;
      }
      this.namespace.emit(event, payload);
    } catch (error) {
      this.logger.warn(
        `Realtime emit failed (write already committed). event=${event} id=${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ─────────────────────────── the revalidation sweep ───────────────────────────

  /**
   * **Fact E's resolution.** A socket has no next request, so a suspended, demoted or soft-deleted
   * admin would otherwise keep receiving PII until they closed the tab.
   *
   * This is NOT new revocation machinery: there is no token-version column, no
   * `userId → sessionIds` index, no revocation list. The existing model — "the DB is the authority;
   * re-read it" — is preserved verbatim. Only the *trigger* changes: for HTTP it is the next
   * request, for a socket it is this timer, and the predicate is the same `isRealtimeEligible` over
   * the same columns.
   *
   * **Stated maximum exposure window after a revoking write commits: 35 seconds** — a 30 s period
   * plus a 5 s execution budget. Applies uniformly to deletion, suspension, demotion, forced reset
   * and logout.
   *
   * `.unref()` so Jest never hangs on an open handle and `app.close()` always resolves.
   */
  private startRevalidationSweep(): void {
    const intervalMs = resolveRevalidateIntervalMs(
      this.config.get<string>('WS_REVALIDATE_INTERVAL_MS'),
    );
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.sweepTimer.unref();
  }

  /** Exposed for the spec; production drives it from the interval only. */
  async sweep(): Promise<void> {
    if (this.sweeping) {
      // Non-reentrant: a sweep still running when the timer fires again is skipped rather than
      // stacked. Overlapping sweeps would multiply the Redis/DB load exactly when it is worst.
      return;
    }
    const namespace = this.namespace;
    if (!namespace) return;

    const sockets = Array.from(namespace.sockets.values());
    // Zero I/O when nobody is watching.
    if (sockets.length === 0) return;

    this.sweeping = true;
    const startedAt = Date.now();
    try {
      const survivors = await this.sweepBySid(sockets);
      await this.sweepByUser(survivors);
    } catch (error) {
      // A sweep must never take the process down; the next tick retries.
      this.logger.error(
        `Realtime revalidation sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.sweeping = false;
      const elapsed = Date.now() - startedAt;
      if (elapsed > WS_SWEEP_BUDGET_MS) {
        // The ONLY way the stated 35 s window can be exceeded, so it must be visible.
        this.logger.warn(
          `Realtime revalidation sweep exceeded its ${WS_SWEEP_BUDGET_MS}ms budget (${elapsed}ms, sockets=${sockets.length}).`,
        );
      }
    }
  }

  /**
   * Step 2 — dedupe by `sid` and re-read the SESSION STORE.
   *
   * This step, and only this step, covers **explicit logout**: `POST /auth/system/logout` destroys
   * the Redis key while leaving the `SystemUser` row perfectly valid, so a DB-only check would
   * leave the socket alive. Idle-TTL expiry and an evicted key land here too.
   *
   * A store error DISCONNECTS. Fail closed — Redis being down must never mean "assume the socket is
   * still fine" — but with `STORE_UNAVAILABLE` so the client heals once Redis recovers.
   */
  private async sweepBySid(sockets: Socket[]): Promise<Socket[]> {
    const bySid = groupBy(sockets, (socket) => socketData(socket).sid ?? '');
    const survivors: Socket[] = [];

    for (const [sid, group] of bySid) {
      const expectedUserId = socketData(group[0]).systemUserId;

      if (!sid) {
        this.closeAll(group, SESSION_CLOSED_REASONS.revoked);
        continue;
      }

      let session: SessionData | null;
      try {
        session = await this.readSession(sid);
      } catch (error) {
        this.logger.error(
          `Realtime sweep could not read the session store; disconnecting ${group.length} socket(s): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.closeAll(group, SESSION_CLOSED_REASONS.storeUnavailable);
        continue;
      }

      const revoked =
        !session ||
        session.systemUserId !== expectedUserId ||
        Date.now() - (session.createdAt ?? 0) > SESSION_ABSOLUTE_MAX_AGE_MS;

      if (revoked) {
        this.closeAll(group, SESSION_CLOSED_REASONS.revoked);
        continue;
      }

      survivors.push(...group);
    }

    return survivors;
  }

  /**
   * Step 3 — dedupe by `systemUserId` and re-read the DATABASE: one indexed PK read per distinct
   * surviving user, never one per socket. Covers deletion, suspension, a forced password reset and
   * a demotion out of `{SUPER_ADMIN, ADMIN}` — the same predicate the handshake applied.
   */
  private async sweepByUser(sockets: Socket[]): Promise<void> {
    const byUser = groupBy(
      sockets,
      (socket) => socketData(socket).systemUserId ?? '',
    );

    for (const [systemUserId, group] of byUser) {
      if (!systemUserId) {
        this.closeAll(group, SESSION_CLOSED_REASONS.revoked);
        continue;
      }

      const result = await resolveSystemUserById(this.prisma, systemUserId);
      if (!result.ok || !isRealtimeEligible(result.user)) {
        this.closeAll(group, SESSION_CLOSED_REASONS.revoked);
      }
    }
  }

  /** Promise wrapper over the callback-style session store. READ ONLY — never `set`/`destroy`. */
  private readSession(sid: string): Promise<SessionData | null> {
    return new Promise<SessionData | null>((resolve, reject) => {
      if (!this.store) {
        reject(new Error('Session store is not initialised.'));
        return;
      }
      // `void`: connect-redis's `get` is dual callback/promise. We consume the CALLBACK, so the
      // returned promise is deliberately ignored — awaiting it would double-settle this wrapper.
      void this.store.get(
        sid,
        (error: unknown, session?: SessionData | null) => {
          if (error)
            reject(
              error instanceof Error
                ? error
                : // `error` is `unknown` here, so `String(error)` would risk "[object Object]".
                  new Error(
                    typeof error === 'string'
                      ? error
                      : 'Session store read failed.',
                  ),
            );
          else resolve(session ?? null);
        },
      );
    });
  }

  /**
   * Emits `session.closed { reason }` and then disconnects.
   *
   * The reason code exists because Socket.IO does NOT auto-reconnect after a server-initiated
   * disconnect. That is right for `REVOKED` (the revoked admin's client stops on its own) and wrong
   * for `STORE_UNAVAILABLE` (a healthy admin's realtime must heal itself once Redis recovers).
   *
   * PII discipline: the log line carries the socket id and the reason only.
   */
  private closeAll(sockets: Socket[], reason: SessionClosedReason): void {
    for (const socket of sockets) {
      try {
        socket.emit(REALTIME_EVENTS.sessionClosed, { reason });
      } catch (error) {
        this.logger.warn(
          `Failed to send session.closed before disconnecting: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      socket.disconnect(true);
    }
    if (sockets.length > 0) {
      this.logger.log(
        `Realtime sockets closed by revalidation sweep. count=${sockets.length} reason=${reason}`,
      );
    }
  }
}

/** Small grouping helper — the sweep is O(distinct sids/users), never O(sockets). */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = groups.get(k);
    if (bucket) bucket.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}
