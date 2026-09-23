import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { AppAccess } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { Namespace, Socket } from 'socket.io';
import {
  extractBearerToken,
  verifyLineIdToken,
} from '../line/guards/line-id-token.guard';
import { PrismaService } from '../prisma/prisma.service';
import { VenueWatchDto } from './dto/venue-watch.dto';
import {
  CLIENT_MAX_ROOMS_PER_SOCKET,
  CLIENT_REALTIME_EVENTS,
  CLIENT_REALTIME_MESSAGES,
  CLIENT_SCHEDULE_ROOM,
  REALTIME_CLIENT_NAMESPACE,
  REALTIME_ERRORS,
  clientUserRoom,
  clientVenueRoom,
} from './realtime.constants';
import { realtimeError, type SocketMiddleware } from './realtime.handshake';

/**
 * Who a `/client` socket belongs to, pinned by the handshake.
 *
 * ⚠️ BOTH FIELDS ARE "THE USER'S ID" AND THEY ARE DIFFERENT VALUES. `id` is the cuid `LineUser.id`
 * (what rooms and `BookingRequest.lineUserId` are keyed on); `lineUserId` is the LINE-side `U…`
 * subject. `lineUserId` is carried for logging and future use only — never build a room from it.
 */
export interface ClientRealtimeIdentity {
  id: string;
  lineUserId: string;
}

export interface ClientRealtimeSocketData {
  lineUser: ClientRealtimeIdentity;
  connectedAt: number;
}

export const clientSocketData = (
  socket: Socket,
): Partial<ClientRealtimeSocketData> =>
  socket.data as Partial<ClientRealtimeSocketData>;

/**
 * The credential, from either of the two places a Socket.IO client can put it.
 *
 * `handshake.auth` is the browser-friendly one (`io(url, { auth: { token } })` — a WebSocket upgrade
 * cannot carry a custom header from a browser at all). `Authorization: Bearer …` is accepted too so
 * a non-browser client, and the e2e suite's polling transport, can use the same header the REST
 * routes take. `auth` wins when both are present; there is no merge and no fallback chain beyond
 * these two.
 */
export function readHandshakeToken(socket: Socket): string | null {
  const auth: unknown = socket.handshake.auth;
  if (typeof auth === 'object' && auth !== null) {
    const raw = (auth as Record<string, unknown>).token;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return extractBearerToken(socket.handshake.headers?.authorization);
}

/** Outcome of the `/client` handshake — an identity, or the client-visible status class. */
export type ClientAuthOutcome =
  { ok: true; lineUser: ClientRealtimeIdentity } | { ok: false; code: string };

/**
 * The `/client` authorize step, as a plain function so the spec can drive it without a socket
 * server.
 *
 * ── THE THREE REFUSALS, AND WHY THEY ARE ONLY TWO CODES ──
 * Like `/admin`, these are **status classes, not diagnostics**. A rejected socket learns nothing
 * about which `LineUser` rows exist or what state they are in.
 *
 * ⚠️ A LINE VERIFY OUTAGE IS `UNAUTHENTICATED`, NOT A RETRYABLE CODE. `verifyLineIdToken` throws a
 * `BadGatewayException` for an unreachable LINE, which on the HTTP surface is a retryable 502 — but
 * a socket that cannot prove who it belongs to must not be held open, so both throws collapse to one
 * refusal here. The trade-off is deliberate and recorded: the client reconnects on its own timer.
 */
export async function authenticateClientSocket(
  config: ConfigService,
  prisma: PrismaService,
  socket: Socket,
  logger: Logger,
): Promise<ClientAuthOutcome> {
  const token = readHandshakeToken(socket);
  if (!token) return { ok: false, code: REALTIME_ERRORS.unauthenticated };

  const channelId = config.get<string>('LINE_LOGIN_CHANNEL_ID', '');
  if (!channelId) {
    // A missing channel id is a deploy defect. HTTP answers 500; a socket has no status line, so it
    // is refused — but the log line must say WHY, or this looks like every other bad token.
    logger.error(
      'LINE_LOGIN_CHANNEL_ID is not set — cannot verify LINE ID tokens on /client.',
    );
    return { ok: false, code: REALTIME_ERRORS.unauthenticated };
  }

  let sub: string;
  try {
    ({ sub } = await verifyLineIdToken(token, channelId));
  } catch (error) {
    // ⚠️ NEVER LOG THE TOKEN. The message is the exception's own generic copy, nothing more.
    logger.warn(
      `/client handshake rejected — LINE token not verified: ${
        error instanceof Error ? error.message : 'unknown verification failure'
      }`,
    );
    return { ok: false, code: REALTIME_ERRORS.unauthenticated };
  }

  // The verified `sub` is the LINE-side `U…` string, so it resolves the row by `lineUserId`.
  // `deletedAt: null` — an unfollowed user is soft-deleted and holds no screen.
  const row = await prisma.lineUser.findFirst({
    where: { lineUserId: sub, deletedAt: null },
    select: { id: true, lineUserId: true, access: true },
  });
  if (!row) return { ok: false, code: REALTIME_ERRORS.unauthenticated };
  if (row.access !== AppAccess.ALLOWED) {
    return { ok: false, code: REALTIME_ERRORS.forbidden };
  }

  return { ok: true, lineUser: { id: row.id, lineUserId: row.lineUserId } };
}

/** Wraps {@link authenticateClientSocket} as a Socket.IO namespace middleware. */
export const createClientAuthenticateMiddleware =
  (
    config: ConfigService,
    prisma: PrismaService,
    logger: Logger,
  ): SocketMiddleware =>
  (socket, next) => {
    void authenticateClientSocket(config, prisma, socket, logger)
      .then((result) => {
        if (!result.ok) {
          next(realtimeError(result.code));
          return;
        }
        const data: ClientRealtimeSocketData = {
          lineUser: result.lineUser,
          connectedAt: Date.now(),
        };
        Object.assign(socket.data as object, data);
        next();
      })
      .catch((error: unknown) => {
        // A DB failure fails CLOSED, exactly as `/admin`'s authorize step does.
        logger.error(
          `/client handshake rejected — user lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        next(realtimeError(REALTIME_ERRORS.unauthenticated));
      });
  };

/**
 * The LINE end-user realtime fan-out (`CLIENT-REALTIME-1`).
 *
 * ── 🔴 HOW THIS DIFFERS FROM `/admin`, AND WHY NONE OF IT IS SHARED ──
 * 1. **The credential.** `/admin` reuses the express session through `SessionIoAdapter`'s cookie +
 *    session middleware chain. A LINE end-user has no session and no cookie, so this namespace
 *    verifies a **LINE ID token** on the handshake — through the SAME `verifyLineIdToken` the REST
 *    guard uses, never a second copy of the `aud`/`iss`/`exp` checks.
 * 2. **Rooms are mandatory here.** On `/admin`, namespace membership *is* the `SUPER_ADMIN|ADMIN`
 *    boundary, so every socket may see everything and there are no rooms. Membership here means only
 *    "an `ALLOWED` LINE user" — nearly everybody — so `D-C13` is enforced by targeting
 *    `user:<cuid>` and `venue:<id>` instead. A namespace-wide `emit` on this gateway would be a
 *    privacy bug; there is deliberately no method that performs one.
 * 3. **It accepts inbound messages** — the first two in the codebase. `/admin` has zero by design and
 *    keeps zero.
 *
 * ⚠️ STILL SERVER → CLIENT FOR EVERY *WRITE*. `venue:watch` / `venue:unwatch` change room membership
 * and nothing else: no booking is created, cancelled or approved over this socket.
 *
 * ⚠️ ORIGIN: `SessionIoAdapter` installs `originGuard(CORS_ORIGIN)` at the ENGINE level, so it
 * applies to `/client` too. A LIFF client's origin must therefore be in `CORS_ORIGIN` — that is a
 * deploy concern, but it is the first thing to check when a real device cannot connect.
 */
@WebSocketGateway({ namespace: REALTIME_CLIENT_NAMESPACE })
export class ClientRealtimeGateway
  implements OnGatewayInit<Namespace>, OnGatewayConnection
{
  private readonly logger = new Logger(ClientRealtimeGateway.name);

  /** The `/client` namespace, captured in `afterInit`. Undefined in a socket-less unit test. */
  private namespace?: Namespace;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(namespace: Namespace): void {
    this.namespace = namespace;
    namespace.use(
      createClientAuthenticateMiddleware(this.config, this.prisma, this.logger),
    );
  }

  /**
   * Auto-join, and it runs only for sockets the middleware already accepted.
   *
   * The identity check is belt-and-braces: `handleConnection` cannot be reached without the
   * middleware having called `next()`, but a socket with no identity must never end up holding
   * `schedule:all` — so it is closed rather than silently joined.
   */
  handleConnection(socket: Socket): void {
    const identity = clientSocketData(socket).lineUser;
    if (!identity) {
      this.logger.warn(
        `/client socket connected without an identity; closing. socket=${socket.id}`,
      );
      socket.disconnect(true);
      return;
    }

    // `join` is synchronous on the in-memory adapter and returns `void | Promise<void>`; the `void`
    // operator keeps `no-floating-promises` honest for a clustered adapter that returns a promise.
    void socket.join(clientUserRoom(identity.id));
    void socket.join(CLIENT_SCHEDULE_ROOM);

    // PII discipline: the row id, never the LINE `U…` sub, never a display name.
    this.logger.log(`/client socket connected. lineUser=${identity.id}`);
  }

  /**
   * `venue:watch` — follow one venue's availability.
   *
   * 🔴 THE PAYLOAD IS VALIDATED HERE, BY HAND, AND THAT IS NOT AN OVERSIGHT. `configureApp`'s global
   * `ValidationPipe` *is* wired into the WS context, but it is a **no-op for this handler**: the
   * declared parameter type is `unknown`, which compiles to the `Object` metatype the pipe
   * deliberately skips. Typing the parameter as `VenueWatchDto` to hand it over would trade a
   * deterministic ack for a thrown `BadRequestException` surfacing as an `exception` event — a
   * different, noisier contract on the one inbound surface in this module. So `parseVenueWatch`
   * applies the same `whitelist` + `forbidNonWhitelisted` strictness the REST boundary uses, and the
   * refusal is a value the caller can branch on.
   *
   * An invalid payload joins nothing and answers `{ ok: false }` — the same answer a valid id for a
   * venue that does not exist gets, so the ack is never an existence oracle.
   */
  @SubscribeMessage(CLIENT_REALTIME_MESSAGES.venueWatch)
  handleVenueWatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean } {
    const venueId = parseVenueWatch(body);
    if (!venueId) return { ok: false };

    if (socket.rooms.size >= CLIENT_MAX_ROOMS_PER_SOCKET) {
      this.logger.warn(
        `/client socket refused venue:watch — room ceiling reached. socket=${socket.id}`,
      );
      return { ok: false };
    }

    void socket.join(clientVenueRoom(venueId));
    return { ok: true };
  }

  /** `venue:unwatch` — stop following. Leaving a room the socket is not in is a no-op. */
  @SubscribeMessage(CLIENT_REALTIME_MESSAGES.venueUnwatch)
  handleVenueUnwatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean } {
    const venueId = parseVenueWatch(body);
    if (!venueId) return { ok: false };

    void socket.leave(clientVenueRoom(venueId));
    return { ok: true };
  }

  // ───────────────────────────── emit surface ─────────────────────────────

  /**
   * Sends to ONE user's room.
   *
   * ⚠️ THE PARAMETER IS THE **cuid** `LineUser.id`, and it is named `lineUserRowId` rather than
   * `lineUserId` for exactly that reason: `LineUser.lineUserId` is the LINE-side `U…` subject and
   * passing it here would build a room nobody is in — an event that vanishes instead of failing.
   * `BookingRequest.lineUserId` IS this cuid (`schema.prisma`), so a booking row's column is the
   * right thing to pass.
   */
  emitToUser(lineUserRowId: string, event: string, payload: unknown): void {
    this.emit(clientUserRoom(lineUserRowId), event, payload);
  }

  /** Sends to everyone currently watching one venue. */
  emitToVenue(venueId: string, event: string, payload: unknown): void {
    this.emit(clientVenueRoom(venueId), event, payload);
  }

  /**
   * The one broadcast every `/client` socket receives — and it is **payload-free** (`D-C13`).
   *
   * 🔴 DO NOT ADD AN ARGUMENT TO THIS METHOD. `schedule:all` holds every connected end-user, so
   * anything it carries is published to all of them. It says "the approved schedule moved, refetch
   * what you are showing" and must never say whose booking moved, where, or why.
   */
  emitSchedulePulse(): void {
    this.emit(
      CLIENT_SCHEDULE_ROOM,
      CLIENT_REALTIME_EVENTS.scheduleUpdated,
      undefined,
    );
  }

  /**
   * Synchronous, `void`, and it NEVER throws — the same fail-soft discipline as `RealtimeGateway`.
   * The write has already committed by the time we get here, so a fan-out failure is logged at
   * `warn` and swallowed rather than failing an HTTP mutation.
   *
   * PII discipline: the log line carries the event name and the room only — and a room name is an
   * id, never a name, a phone number or a purpose.
   */
  private emit(room: string, event: string, payload: unknown): void {
    try {
      if (!this.namespace) {
        this.logger.warn(
          `Client realtime emit skipped (gateway not initialised). event=${event} room=${room}`,
        );
        return;
      }
      if (payload === undefined) this.namespace.to(room).emit(event);
      else this.namespace.to(room).emit(event, payload);
    } catch (error) {
      this.logger.warn(
        `Client realtime emit failed (write already committed). event=${event} room=${room}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Validates a `venue:watch`/`venue:unwatch` payload and returns the venue id, or `null`.
 *
 * `forbidUnknownValues` + a rejection of any non-object keeps a bare string or an array from being
 * coerced into a DTO, which `plainToInstance` would otherwise do happily.
 */
export function parseVenueWatch(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const dto = plainToInstance(VenueWatchDto, body);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  return errors.length === 0 ? dto.venueId : null;
}
