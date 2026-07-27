import { Logger } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Socket } from 'socket.io';
import {
  resolveSessionUser,
  type SessionPayload,
} from '../auth/session-user.resolver';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicSystemUser } from '../system-users/system-users.fields';
import { REALTIME_ERRORS } from './realtime.constants';

const logger = new Logger('RealtimeHandshake');

/** A Socket.IO namespace middleware. `next(err)` rejects the connection. */
export type SocketMiddleware = (
  socket: Socket,
  next: (err?: Error) => void,
) => void;

/** What the handshake pins onto the socket for the revalidation sweep to re-check later. */
export interface RealtimeSocketData {
  systemUserId: string;
  sid: string;
  connectedAt: number;
}

/** A handshake request after `cookieParser` + `express-session` have run over it. */
export type SessionedRequest = Request & {
  session?: SessionPayload;
  sessionID?: string;
};

export const sessionedRequest = (socket: Socket): SessionedRequest =>
  socket.request as unknown as SessionedRequest;

export const socketData = (socket: Socket): Partial<RealtimeSocketData> =>
  socket.data as Partial<RealtimeSocketData>;

/** A connection rejection whose `message` is the client-visible code, and nothing else. */
export const realtimeError = (code: string): Error => new Error(code);

/**
 * THE single predicate for "may this `SystemUser` hold an `/admin` socket".
 *
 * One function so the handshake (§3.4) and the revocation sweep (§4) can never test different
 * things. `mustChangePassword` is unconditional here — unlike HTTP, there is no decorator to opt a
 * socket out of the forced-reset gate, and there is nothing on this transport a gated user needs.
 *
 * **`role` is `SystemRole`, the RBAC enum — never `personnelRole.name`.** A `PersonnelRole` row
 * named "ADMIN" grants nothing.
 */
export const isRealtimeEligible = (
  user: Pick<PublicSystemUser, 'role' | 'mustChangePassword'>,
): boolean =>
  !user.mustChangePassword &&
  (user.role === SystemRole.SUPER_ADMIN || user.role === SystemRole.ADMIN);

/**
 * The classic socket.io ↔ express-middleware adapter.
 *
 * `res` is a stub because nothing in this chain writes a response: the handshake only READS the
 * session. That is also what makes a socket unable to extend a session — `rolling: true` fires from
 * `express-session`'s patched `res.end`, which is never called here, so an admin with a socket open
 * but no HTTP activity still has their idle window expire on schedule.
 */
export const wrapExpressMiddleware =
  (mw: RequestHandler): SocketMiddleware =>
  (socket, next) => {
    mw(
      socket.request as unknown as Request,
      {} as unknown as Response,
      next as unknown as NextFunction,
    );
  };

/**
 * The same adapter for `createSessionMiddleware`, with one addition: a store failure is normalised
 * to the `SESSION_STORE_UNAVAILABLE` code before it reaches the client.
 *
 * **Fail-closed comes from `express-session` itself, not from us.** With Redis unreachable its
 * `store.get` callback receives an error and it calls `next(err)`; in a socket.io middleware chain
 * `next(err)` rejects the connection. There is deliberately no fallback path, no `try/catch` that
 * lets the socket through, and no second code path to keep correct — this wrapper only renames the
 * error so the client can tell "retry me" (store down) from "stop" (unauthenticated/forbidden).
 * The underlying reason is logged server-side and never sent to the client.
 */
export const wrapSessionMiddleware =
  (mw: RequestHandler): SocketMiddleware =>
  (socket, next) => {
    mw(
      socket.request as unknown as Request,
      {} as unknown as Response,
      (error?: unknown) => {
        if (error) {
          logger.error(
            // `error` is `unknown`, so `String(error)` would risk logging "[object Object]".
            `Realtime handshake rejected — session store failure: ${
              error instanceof Error
                ? error.message
                : typeof error === 'string'
                  ? error
                  : 'unknown session store error'
            }`,
          );
          next(realtimeError(REALTIME_ERRORS.sessionStoreUnavailable));
          return;
        }
        next();
      },
    );
  };

/**
 * The authorize step. Runs after `cookieParser` + `express-session`, so `socket.request.session`
 * carries whatever Redis holds for the `eb.sid` cookie.
 *
 * Outcomes are exactly three coarse codes (§3.4). Nothing here distinguishes "no cookie" from
 * "deleted user" — a rejected socket learns only the status class, never an id, email or role.
 *
 * It NEVER writes to the session store: no `destroy()`, no `save()`, no `touch()`. A rejected
 * handshake leaves the (already worthless) key alone; the victim's next HTTP request hits
 * `SessionGuard`, which destroys it exactly as it does today.
 */
export const createAuthenticateMiddleware =
  (prisma: PrismaService): SocketMiddleware =>
  (socket, next) => {
    const req = sessionedRequest(socket);
    void resolveSessionUser(prisma, req.session)
      .then((result) => {
        if (!result.ok) {
          next(realtimeError(REALTIME_ERRORS.unauthenticated));
          return;
        }
        if (!isRealtimeEligible(result.user)) {
          next(realtimeError(REALTIME_ERRORS.forbidden));
          return;
        }

        const data: RealtimeSocketData = {
          systemUserId: result.user.id,
          sid: req.sessionID ?? '',
          connectedAt: Date.now(),
        };
        Object.assign(socket.data as object, data);
        next();
      })
      .catch((error: unknown) => {
        // A DB failure must fail CLOSED, exactly like the store failure above.
        logger.error(
          `Realtime handshake rejected — user lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        next(realtimeError(REALTIME_ERRORS.unauthenticated));
      });
  };
