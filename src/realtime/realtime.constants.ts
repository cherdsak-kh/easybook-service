/**
 * The realtime (Socket.IO) transport's wire vocabulary, in one file so the gateway, the handshake,
 * the adapter and the specs can never disagree about a string.
 */

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
export const REALTIME_NAMESPACE_ALLOWLIST: readonly string[] = [
  REALTIME_ADMIN_NAMESPACE,
];

/** Server → client events. There are no client → server events (zero `@SubscribeMessage`). */
export const REALTIME_EVENTS = {
  /** This row now exists (or re-exists) in the operator's list. Payload: `LineUserResponseDto`. */
  lineUserCreated: 'lineUser.created',
  /** This row's contents changed. Payload: `LineUserResponseDto`. */
  lineUserUpdated: 'lineUser.updated',
  /** This row left the operator's list (soft delete). Payload: `{ id }`. */
  lineUserDeleted: 'lineUser.deleted',
  /** Control plane — emitted immediately before the sweeper disconnects a socket. */
  sessionClosed: 'session.closed',
} as const;

/**
 * The three handshake rejection codes, surfaced to the client as `connect_error.message`, plus the
 * engine-level origin rejection.
 *
 * They are **status classes, not diagnostics**: nothing distinguishes "no cookie" from "deleted
 * user", exactly as the HTTP surface refuses to distinguish them. No id, email or role is ever sent
 * to a rejected socket.
 */
export const REALTIME_ERRORS = {
  /** 401's analogue: no cookie, expired session, user gone, soft-deleted, or suspended. */
  unauthenticated: 'UNAUTHENTICATED',
  /** 403's analogue: `STAFF`, or `mustChangePassword`. */
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
