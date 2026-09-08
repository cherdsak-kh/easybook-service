/**
 * The realtime (Socket.IO) transport's wire vocabulary, in one file so the gateway, the handshake,
 * the adapter and the specs can never disagree about a string.
 */

import type { BookingStatus } from '@prisma/client';

/**
 * The admin fan-out namespace. Full connect target: `<backend origin>/admin`.
 *
 * A NAMESPACE, not the default `/`, so a future client-portal/LIFF socket cannot inherit the admin
 * handshake.
 *
 * **Not declaring `/` closes NOTHING** — an earlier version of this comment claimed it did, and that
 * claim was false (design Amendment A1). `socket.io`'s `Server` constructor runs
 * `this.sockets = this.of("/")` unconditionally, so `/` always exists and the `Invalid namespace`
 * branch is never reached for it. What actually closes `/`, and every namespace that is not this one,
 * is `REALTIME_NAMESPACE_ALLOWLIST` below, sealed in `SessionIoAdapter`. AC B1 is that seal, not an
 * absence.
 *
 * There are **no rooms**: every socket here passed the same `SUPER_ADMIN|ADMIN` gate as
 * `GET /line-users`, so namespace membership IS the authorization boundary.
 */
export const REALTIME_ADMIN_NAMESPACE = '/admin';

/**
 * THE set of namespaces this server will serve. Anything else — including socket.io's
 * unconditionally-created default `/` — is refused at the namespace layer with
 * `REALTIME_ERRORS.unauthenticated`.
 *
 * FAIL CLOSED, BY CONSTRUCTION. Adding a `@WebSocketGateway({ namespace })` is NOT enough to make it
 * reachable: its name must be added here AND it must install its own handshake chain. That trip-wire
 * is deliberate — the original design assumed an undeclared namespace was closed for free, which is
 * false (see `REALTIME_ADMIN_NAMESPACE` above).
 */
/**
 * The LINE end-user fan-out namespace (`CLIENT-REALTIME-1`). Full connect target:
 * `<backend origin>/client`.
 *
 * 🔴 A SECOND NAMESPACE, NOT A RELAXATION OF THE FIRST. The two sides prove identity by entirely
 * different means — `/admin` reads an express session cookie, `/client` verifies a **LINE ID token**
 * on the handshake — and a LINE end-user has neither session nor cookie. Nothing about `/admin`,
 * `isRealtimeEligible` or `SessionIoAdapter`'s session chain changes to accommodate this.
 *
 * ⚠️ UNLIKE `/admin`, THIS NAMESPACE HAS ROOMS AND NEEDS THEM. Namespace membership here means only
 * "an `ALLOWED` LINE user", which is nearly everybody — so it is NOT an authorization boundary.
 * `D-C13` (no request details on a shared channel) is enforced by {@link clientUserRoom} /
 * {@link clientVenueRoom} instead. See {@link CLIENT_SCHEDULE_ROOM} for the one shared room and the
 * rule that keeps it safe.
 */
export const REALTIME_CLIENT_NAMESPACE = '/client';

export const REALTIME_NAMESPACE_ALLOWLIST: readonly string[] = [
  REALTIME_ADMIN_NAMESPACE,
  REALTIME_CLIENT_NAMESPACE,
];

/**
 * Who performed the change an event describes, or `null` when no operator did — a LINE user
 * following the account, or registering/editing their own details through the LIFF app.
 *
 * ⚠️ THIS IS OPERATIONAL PROVENANCE, NOT AN AUDIT TRAIL, and the difference is worth defending.
 * It answers the one question a row changing under your cursor raises — "who just did that?" — for
 * people who can already see the entire directory. It is not retained, not queryable, and not
 * evidence. A real audit log is its own table and its own screen (`reports/activity`), and neither
 * exists; adding fields here until it resembles one would produce a log that is neither.
 *
 * `name` is the display name an operator already sees on the staff screen. No email, no role, no
 * id beyond what is needed to recognise a colleague.
 */
export interface RealtimeActor {
  id: string;
  name: string;
}

/**
 * `/admin`'s server → client events. That namespace has no client → server events at all (zero
 * `@SubscribeMessage`) — `/client` is the one that accepts inbound messages, and only two of them
 * (see {@link CLIENT_REALTIME_MESSAGES}).
 */
export const REALTIME_EVENTS = {
  /** This row now exists (or re-exists). Payload: `{ user, actor }`. */
  lineUserCreated: 'lineUser.created',
  /** This row's contents changed. Payload: `{ user, actor }`. */
  lineUserUpdated: 'lineUser.updated',
  /** This row left the operator's list (soft delete). Payload: `{ id, actor }`. */
  lineUserDeleted: 'lineUser.deleted',
  /**
   * This booking request now exists in the approval queue. Payload: `{ booking, actor }`, where
   * `booking` is an `AdminBookingRequestListItemDto` — byte for byte the row shape
   * `GET /booking-requests` returns, so a live-inserted row and a refreshed one can never disagree.
   *
   * Two origins, and `actor` is what tells them apart: a LIFF submission (`actor: null` — a LINE
   * user, not an operator) or a staff `POST /booking-requests/direct`, which is born `APPROVED`.
   */
  bookingRequestCreated: 'bookingRequest.created',
  /**
   * This booking request's contents changed — approved, rejected, cancelled, **or auto-rejected by
   * ADR-001** because somebody else's overlapping request took the room. Payload:
   * `{ booking, actor }`, the same shape as `bookingRequest.created`.
   *
   * 🔴 ONE EVENT PER ROW THAT CHANGED, NEVER ONE PER OPERATION. An approval that bumps two
   * overlapping pending requests emits THREE of these: the subject and both losers. The losers are
   * rows on other people's screens and they changed; announcing only the subject is precisely the
   * defect this vocabulary was added to fix.
   */
  bookingRequestUpdated: 'bookingRequest.updated',
  /** Control plane — emitted immediately before the sweeper disconnects a socket. */
  sessionClosed: 'session.closed',
} as const;

// ───────────────────────────── /client (CLIENT-REALTIME-1) ─────────────────────────────

/**
 * The room a single LINE end-user's private events go to.
 *
 * ⚠️ THE ARGUMENT IS THE **cuid** `LineUser.id`, never the LINE-side `U…` string that
 * `LineUser.lineUserId` holds. Both are "the user's id" in English and they are different values;
 * keying the room on the wrong one produces a room nobody is in and an event nobody receives — a
 * silent failure, not a loud one. `BookingRequest.lineUserId` is ALSO the cuid (`schema.prisma`), so
 * a booking row's column can be passed straight through.
 */
export const clientUserRoom = (lineUserRowId: string): string =>
  `user:${lineUserRowId}`;

/** The room every socket currently watching one venue's calendar sits in. */
export const clientVenueRoom = (venueId: string): string => `venue:${venueId}`;

/**
 * The ONE room every `/client` socket joins on connect.
 *
 * 🔴 `D-C13`: BECAUSE EVERYONE IS IN IT, WHATEVER GOES TO IT MUST CARRY NO REQUEST DETAILS AT ALL.
 * It is a "something changed, refetch" pulse and not a data channel — see
 * {@link CLIENT_REALTIME_EVENTS.scheduleUpdated}. Adding a payload here is how a privacy boundary
 * gets deleted by accident.
 */
export const CLIENT_SCHEDULE_ROOM = 'schedule:all';

/** `/client` server → client events. */
export const CLIENT_REALTIME_EVENTS = {
  /**
   * A booking's status moved — approved, rejected, auto-rejected by ADR-001, or cancelled.
   * Room: `user:<LineUser.id>`. Payload: {@link ClientBookingUpdatedPayload}.
   *
   * 🔴 IT GOES TO EXACTLY ONE PERSON'S ROOM, and that is the whole of `D-C13` on this event: the
   * payload names a request and its reason, which nobody else may see.
   */
  bookingUpdated: 'client.bookingUpdated',
  /**
   * A slot at this venue was taken or freed. Room: `venue:<Venue.id>`. Payload:
   * {@link ClientVenueAvailabilityPayload}.
   *
   * 🔴 NO REQUESTER, NO PURPOSE, NO CODE — not even for the person who owns the booking. The room is
   * shared by everyone with that venue's calendar open, so the event says only *that* the venue's
   * availability moved; the client refetches the range it is actually showing.
   */
  venueAvailabilityChanged: 'client.venueAvailabilityChanged',
  /**
   * An approved booking somewhere in the org changed. Room: {@link CLIENT_SCHEDULE_ROOM}.
   *
   * 🔴 **NO PAYLOAD.** Not `{}` with fields for later, not a venue id — nothing. See
   * {@link CLIENT_SCHEDULE_ROOM}.
   */
  scheduleUpdated: 'client.scheduleUpdated',
} as const;

/**
 * `/client` client → server messages. THE ONLY INBOUND SURFACE IN THIS MODULE.
 *
 * ⚠️ They subscribe, they never write. No booking is created, cancelled or approved over a socket —
 * every write in this product goes through REST so it can answer with a status code and a reason.
 */
export const CLIENT_REALTIME_MESSAGES = {
  venueWatch: 'venue:watch',
  venueUnwatch: 'venue:unwatch',
} as const;

/** `client.bookingUpdated`'s payload — the four fields a card needs to flip. */
export interface ClientBookingUpdatedPayload {
  id: string;
  code: string;
  status: BookingStatus;
  /** The approver's reason, or ADR-001's auto-rejection copy. `null` on every other transition. */
  rejectReason: string | null;
}

/** `client.venueAvailabilityChanged`'s payload — which venue, and nothing else. */
export interface ClientVenueAvailabilityPayload {
  venueId: string;
}

/**
 * The most rooms one `/client` socket may hold.
 *
 * `venue:watch` is the one thing a client can make the server allocate, so it gets a ceiling: a
 * socket that joined an unbounded number of rooms would grow the adapter's room map for free. The
 * count includes the three rooms every socket already holds (its own id, `user:<cuid>` and
 * `schedule:all`), and a real client watches one venue at a time — so this is generous, not tight.
 */
export const CLIENT_MAX_ROOMS_PER_SOCKET = 32;

/**
 * The three handshake rejection codes, surfaced to the client as `connect_error.message`, plus the
 * engine-level origin rejection.
 *
 * They are **status classes, not diagnostics**: nothing distinguishes "no cookie" from "deleted
 * user", exactly as the HTTP surface refuses to distinguish them. No id, email or role is ever sent
 * to a rejected socket.
 */
export const REALTIME_ERRORS = {
  /**
   * 401's analogue.
   * - `/admin`: no cookie, expired session, user gone, soft-deleted, or suspended.
   * - `/client`: no LINE ID token, a token LINE rejected, no `LineUser` row for the verified `sub`,
   *   a soft-deleted one — **and a LINE verify outage too**, because a socket handshake that cannot
   *   be proven must fail closed.
   */
  unauthenticated: 'UNAUTHENTICATED',
  /**
   * 403's analogue.
   * - `/admin`: `VIEWER`, or `mustChangePassword`.
   * - `/client`: the `LineUser` exists but their `access` is not `ALLOWED` (`UNREGISTERED`,
   *   `PENDING`, `REJECTED`, `BLOCKED`) — they hold no screen a socket could keep truthful.
   */
  forbidden: 'FORBIDDEN',
  /** 503's analogue: the session store errored. The client should keep retrying. */
  sessionStoreUnavailable: 'SESSION_STORE_UNAVAILABLE',
  /** CSWSH control: the `Origin` header was present and not in the `CORS_ORIGIN` allowlist. */
  forbiddenOrigin: 'FORBIDDEN_ORIGIN',
} as const;

/**
 * `session.closed` reasons. The distinction is what lets a revoked client stop while a
 * store-unavailable client heals: Socket.IO does not auto-reconnect after a server-initiated
 * disconnect, so without a reason code a transient Redis outage would permanently kill realtime.
 */
export const SESSION_CLOSED_REASONS = {
  /** Session destroyed/expired, or the user was deleted, suspended, demoted or reset. Stop. */
  revoked: 'REVOKED',
  /** The session store errored during the sweep. Reconnect on a backoff timer. */
  storeUnavailable: 'STORE_UNAVAILABLE',
} as const;

export type SessionClosedReason =
  (typeof SESSION_CLOSED_REASONS)[keyof typeof SESSION_CLOSED_REASONS];

/** Revalidation sweep period. Env-overridable via `WS_REVALIDATE_INTERVAL_MS` (e2e drives it fast). */
export const DEFAULT_WS_REVALIDATE_INTERVAL_MS = 30_000;

/**
 * The sweep's execution budget. Design target 30 s + this 5 s budget = the **stated maximum
 * exposure window of 35 seconds** after a revoking write commits. Exceeding it is the only way that
 * window can be missed, so it is logged at `warn` — it must be visible.
 */
export const WS_SWEEP_BUDGET_MS = 5_000;
