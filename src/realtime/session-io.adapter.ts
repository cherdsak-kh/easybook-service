import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'http';
import type { Namespace, Server } from 'socket.io';
import { asOriginList, resolveCorsOrigin } from '../config/cors';
import {
  REALTIME_ERRORS,
  REALTIME_NAMESPACE_ALLOWLIST,
} from './realtime.constants';
import type { SocketMiddleware } from './realtime.handshake';

/** engine.io's `allowRequest` callback shape. */
export type AllowRequestDone = (err: string | null, ok: boolean) => void;

/**
 * **This is a security control, not hygiene.**
 *
 * Browsers do NOT apply the same-origin policy to `new WebSocket()`, and they DO attach cookies.
 * With `SESSION_COOKIE_SAMESITE=none` — which the cross-origin SPA already requires — a page at
 * `https://evil.example` could open a socket to this backend carrying the victim admin's session
 * cookie and receive the full PII fan-out. That is **Cross-Site WebSocket Hijacking**, the
 * socket-shaped version of the threat CSRF addresses.
 *
 * socket.io's `cors` option is **not sufficient on its own**: it governs the polling/XHR transport,
 * where the browser enforces CORS. The raw WebSocket upgrade is not subject to CORS at all, so
 * without this the `websocket` transport would accept any origin. `allowRequest` runs for EVERY
 * transport and EVERY namespace, including `/`, and rejects before any resource is allocated.
 *
 * **A missing `Origin` is allowed, deliberately.** A same-origin `GET` XHR (the dev setup, where
 * the SPA reaches the socket through the Vite proxy) omits it, and a browser CANNOT suppress
 * `Origin` on a WebSocket upgrade. A non-browser client (curl, wscat) has no ambient cookie
 * authority — it would have to supply a stolen cookie, which is a different and already-lost game.
 * The rule is: **present ⇒ must be in the allowlist; absent ⇒ allowed.**
 *
 * The allowlist is `CORS_ORIGIN`, parsed by the same `resolveCorsOrigin` the HTTP layer uses.
 * Never `*`.
 */
export const originGuard =
  (allowlist: string | string[]) =>
  (req: IncomingMessage, done: AllowRequestDone): void => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      done(null, true);
      return;
    }
    if (asOriginList(allowlist).includes(origin)) {
      done(null, true);
      return;
    }
    done(REALTIME_ERRORS.forbiddenOrigin, false);
  };

/**
 * **Fail-closed namespace admission.** Refuses every connection to every namespace that is not on
 * `REALTIME_NAMESPACE_ALLOWLIST` (design Amendment A1).
 *
 * Why this exists at all: `socket.io`'s `Server` constructor runs `this.sockets = this.of("/")`
 * unconditionally, so the default `/` namespace ALWAYS exists. "No gateway declares it" therefore
 * closes nothing — before this seal, `/` accepted an anonymous, cookie-less socket and held it
 * indefinitely. The handshake chain lives on the `/admin` `Namespace` object only, so it never
 * covered `/`.
 *
 * Why not `io.use(...)`: in socket.io 4.x `Server.prototype.use` delegates to `this.sockets`, which
 * IS the `/` namespace — a server-level `use` would apply to `/` alone and would never reach
 * `/admin` or any future namespace. The allowlist has to be installed per namespace, which is what
 * this does.
 *
 * **The early return is the "no double-run" guarantee**: for an allowlisted namespace this is a
 * strict no-op, so `/admin`'s middleware array stays exactly `[cookieParser, session, authenticate]`
 * — zero added middleware, zero added I/O, zero added latency on the happy path.
 *
 * The rejection reuses `UNAUTHENTICATED` rather than minting a namespace-specific code: these codes
 * are **status classes, not diagnostics**, and a distinct code would be a namespace-existence oracle
 * (the same reasoning as `isSystemReserved`'s 400-not-403 rule). An authenticated admin who aims at
 * `/` is refused too — the namespace, not the cookie, is the boundary.
 *
 * Honest limit: nothing at this layer can stop the engine.io HTTP connection from being opened (the
 * namespace only appears in a later `CONNECT` packet, which is why `allowRequest` cannot do this
 * job). What it removes is the *promotion* of that connection into a held `Socket`; socket.io's own
 * `connectTimeout` then reaps the bare engine connection.
 */
export const sealNamespaces = (
  io: Server,
  allowlist: readonly string[] = REALTIME_NAMESPACE_ALLOWLIST,
): void => {
  // Stateless, so one shared instance serves every sealed namespace.
  const refuse: SocketMiddleware = (_socket, next) => {
    next(new Error(REALTIME_ERRORS.unauthenticated));
  };

  const seal = (namespace: Namespace): void => {
    if (allowlist.includes(namespace.name)) return;
    namespace.use(refuse);
  };

  // `/` must be sealed EXPLICITLY: `new_namespace` is emitted only for `name !== "/"`
  // (socket.io `index.js`), so the listener below would never see it.
  seal(io.of('/'));

  // Everything created afterwards — `/admin` (a no-op) and any future namespace (refused).
  // `Server.prototype.on` is redirected to the `/` namespace's emitter by socket.io itself.
  io.on('new_namespace', seal);
};

/**
 * The Socket.IO adapter, configured from `ConfigService` at server-creation time.
 *
 * `cors` and `allowRequest` are **engine.io-level (server-wide) options**, not per-namespace, and
 * the `@WebSocketGateway({...})` decorator's metadata is evaluated at *import* time — before
 * `ConfigModule.forRoot()` has loaded `.env` — so the gateway decorator cannot read config. The
 * adapter can, because it is constructed from the already-built application.
 *
 * Registered inside `configureApp(app)`, the one place the pipeline is assembled, so `main.ts` and
 * every e2e spec get byte-identical socket wiring exactly as they already do for CORS/session/CSRF.
 */
export class SessionIoAdapter extends IoAdapter {
  constructor(private readonly app: INestApplication) {
    super(app);
  }

  createIOServer(port: number, options?: Record<string, unknown>): unknown {
    const config = this.app.get(ConfigService);
    const allowlist = resolveCorsOrigin(config);

    const io = super.createIOServer(port, {
      ...options,
      cors: { origin: allowlist, credentials: true },
      allowRequest: originGuard(allowlist),
    }) as Server;

    // Ordering is load-bearing, not a coincidence. Nest's `IoAdapter.create()` is
    // `... : namespace ? this.createIOServer(port, opt).of(namespace) : ...`, so we seal HERE —
    // before `.of('/admin')` is ever called — and the `new_namespace` listener is armed in time.
    // A later gateway takes the `server.of(namespace)` branch on this same, already-sealed server,
    // so it is covered too. `RealtimeGateway.afterInit` runs later still, which is why `/admin`
    // ends up with exactly its three handshake middlewares and nothing prepended.
    sealNamespaces(io);

    return io;
  }
}
