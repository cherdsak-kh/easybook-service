import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisStore } from 'connect-redis';
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import session from 'express-session';
import type { Redis } from 'ioredis';
import { API_BASE_PATH } from '../common/api.constants';
import { SESSION_KEY_PREFIX } from '../redis/redis.constants';
import { isCookieSecure, resolveSameSite } from '../config/env.validation';
import './session.types';

export const DEFAULT_SESSION_COOKIE_NAME = 'eb.sid';
export const DEFAULT_SESSION_TTL_SECONDS = 28_800; // 8h rolling idle (D-6)

/**
 * Paths the session middleware must not touch (DD-3).
 *
 * - `/health` — otherwise a browser holding an `eb.sid` cookie would make the liveness probe
 *   read Redis, so with Redis down `/health` would answer `503` instead of `{ redis: 'down' }`.
 * - `/line/webhook` — an external server-to-server callback with no cookie. Belt and braces for
 *   the LINE signature guard.
 */
export const SESSION_EXEMPT_PATHS: readonly string[] = [
  `${API_BASE_PATH}/health`,
  `${API_BASE_PATH}/line/webhook`,
];

export const sessionCookieName = (config: ConfigService): string =>
  config.get<string>('SESSION_COOKIE_NAME', DEFAULT_SESSION_COOKIE_NAME);

export const sessionCookieOptions = (config: ConfigService) => ({
  httpOnly: true,
  path: '/',
  sameSite: resolveSameSite(config.get<string>('SESSION_COOKIE_SAMESITE')),
  secure: isCookieSecure(config.get<string>('SESSION_COOKIE_SECURE')),
});

const sessionTtlSeconds = (config: ConfigService): number => {
  const raw = Number(config.get<string>('SESSION_TTL_SECONDS'));
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_SESSION_TTL_SECONDS;
};

/**
 * `express-session` backed by Redis.
 *
 * **`store` is UNCONDITIONAL and must stay that way.** `express-session` falls back to its
 * in-memory store only when the `store` option is absent, so a `redisUp ? store : undefined`
 * ternary — or a `try/catch` around the store construction — is the single way to reintroduce
 * the MemoryStore this feature forbids (AC-13). The store is built at boot from a client that
 * may not yet be connected; that is fine, and it is why this must NOT copy `PrismaService`'s
 * fire-and-forget `$connect()` pattern.
 */
export function createSessionMiddleware(
  config: ConfigService,
  redis: Redis,
): RequestHandler {
  const ttlSeconds = sessionTtlSeconds(config);

  return session({
    name: sessionCookieName(config),
    secret: config.getOrThrow<string>('SESSION_SECRET'),
    store: new RedisStore({
      client: redis,
      prefix: SESSION_KEY_PREFIX,
      ttl: ttlSeconds,
    }),
    resave: false,
    // No Redis key for anonymous visitors.
    saveUninitialized: false,
    // D-6: the idle window is refreshed on each request.
    rolling: true,
    cookie: {
      ...sessionCookieOptions(config),
      maxAge: ttlSeconds * 1000,
    },
  });
}

/** Skips the session middleware entirely for the exempt paths (DD-3). */
export const sessionExemptWrapper =
  (mw: RequestHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) =>
    SESSION_EXEMPT_PATHS.includes(req.path) ? next() : mw(req, res, next);

/**
 * Turns a session-store failure into a `503`.
 *
 * Registered immediately after the session middleware, so it only ever sees errors originating
 * in it. This is a raw express error handler, not a Nest exception filter: an error passed to
 * `next(err)` from middleware registered via `app.use()` bypasses Nest's exception layer
 * entirely and would otherwise hit express's default HTML 500 page.
 */
export const sessionStoreErrorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!err) return next();
  if (res.headersSent) return next(err);

  const reason =
    err instanceof Error ? err.message : 'unknown session store error';
  new Logger('Session').error(
    `Session store failure on ${req.method} ${req.path}: ${reason}`,
  );
  res.status(503).json({
    statusCode: 503,
    message: 'Session store unavailable.',
    error: 'Service Unavailable',
  });
};
