import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { doubleCsrf } from 'csrf-csrf';
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import { API_BASE_PATH } from '../common/api.constants';
import { isCookieSecure, resolveSameSite } from '../config/env.validation';

/**
 * `POST /line/webhook` is an external server-to-server callback from LINE. It carries no browser
 * cookie, so there is no ambient authority for CSRF to protect; its authenticity is proven by
 * `LineSignatureGuard`'s HMAC over the raw body. Requiring a CSRF token there would simply break
 * the integration (AC-18).
 *
 * `POST /line-users/register` and `PATCH /line-users/registration` are stateless, bearer-
 * authenticated (LINE ID token) LIFF-client calls with no cookie and no ambient authority, so the
 * double-submit CSRF that protects the cookie-session admin surface is irrelevant to them (same
 * reasoning as the webhook). The two option GETs and `GET /line-users/status` are GETs and already
 * CSRF-safe via `ignoredMethods`. The admin option CRUD is cookie-session and is NOT exempt.
 *
 * `POST /line-users/bookings` (`CLIENT-BOOKING-1`) joins the list on exactly the same grounds: same
 * `LineIdTokenGuard`, same bearer token, same absence of a cookie.
 *
 * 🔴 THE TEST FOR THIS LIST IS "IS THERE AMBIENT AUTHORITY?", NEVER "IS IT INCONVENIENT?". A path
 * belongs here only when the request carries no cookie a foreign origin could ride — a bearer token
 * has to be read and attached by script, which the same-origin policy already prevents. Adding a
 * cookie-session route here would silently remove its CSRF protection with no test failing.
 *
 * ⚠️ MATCHED BY EXACT `req.path`, so every entry here is a literal with no parameters. A route with
 * a path parameter cannot be exempted by this list at all — see {@link CSRF_EXEMPT_PATTERNS}, which
 * exists for exactly that and applies the same admission test. GET routes need no entry in either:
 * `ignoredMethods` already exempts them by method.
 */
export const CSRF_EXEMPT_PATHS: readonly string[] = [
  `${API_BASE_PATH}/line/webhook`,
  `${API_BASE_PATH}/line-users/register`,
  `${API_BASE_PATH}/line-users/registration`,
  `${API_BASE_PATH}/line-users/bookings`,
];

/** Escapes a literal so it can be embedded in a `RegExp` — `API_BASE_PATH` is configuration. */
const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One URL path segment: no `/`, no `.`, and bounded — the shape of a cuid or a booking `code`. */
const SEGMENT = '[A-Za-z0-9_-]{1,64}';

/**
 * The same exemption, for the routes whose paths carry a PARAMETER.
 *
 * 🔴 WHY THIS LIST HAD TO EXIST AT ALL. {@link CSRF_EXEMPT_PATHS} is matched by exact `req.path`,
 * which no parameterised route can ever satisfy — `PATCH /line-users/bookings/<cuid>/cancel` is a
 * different string on every request. Before `CLIENT-BOOKING-2` every cookieless bearer route
 * happened to be a literal, so the limitation cost nothing and reads in that list's own comment as
 * if it were a design choice. It was an accident of the routes that existed.
 *
 * 🔴 THE ADMISSION TEST IS UNCHANGED AND IS THE ONLY THING THAT MATTERS: *is there ambient
 * authority?* Both entries are `LineIdTokenGuard` routes — bearer token, no cookie, nothing a
 * foreign origin could ride. Adding a cookie-session route here would silently remove its CSRF
 * protection with no test failing, and a pattern makes that easier to do by accident than a literal
 * does, which is why the two lists are kept apart rather than merged.
 *
 * ⚠️ EVERY PATTERN IS ANCHORED AT BOTH ENDS AND CONTAINS NO `.` OR `.*`. The segment class excludes
 * `/`, so `^…/bookings/<SEGMENT>/cancel$` cannot be widened by a crafted path — no traversal, no
 * suffix, no second route smuggled in behind a slash. An unanchored or dot-bearing pattern here
 * would be an exemption for paths nobody enumerated.
 */
export const CSRF_EXEMPT_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `^${literal(API_BASE_PATH)}/line-users/bookings/${SEGMENT}/cancel$`,
  ),
  new RegExp(
    `^${literal(API_BASE_PATH)}/line-users/bookings/${SEGMENT}/slots/${SEGMENT}/cancel$`,
  ),
];

/** True when a path is exempt by either list. The only reader is {@link CsrfService.middleware}. */
export const isCsrfExempt = (path: string): boolean =>
  CSRF_EXEMPT_PATHS.includes(path) ||
  CSRF_EXEMPT_PATTERNS.some((re) => re.test(path));

export const CSRF_COOKIE_NAME = 'eb.csrf';
export const INVALID_CSRF_TOKEN = 'Invalid CSRF token.';

/**
 * Signed double-submit cookie CSRF protection (`csrf-csrf`; `csurf` is archived/unmaintained).
 *
 * The token travels in the **`x-csrf-token` header, never in the request body**: the global
 * `ValidationPipe` runs `forbidNonWhitelisted: true`, so a `_csrf` body field would be rejected
 * with `400` before the CSRF middleware could ever be satisfied.
 */
@Injectable()
export class CsrfService {
  private readonly csrf: ReturnType<typeof doubleCsrf>;

  constructor(private readonly config: ConfigService) {
    this.csrf = doubleCsrf({
      getSecret: () => this.config.getOrThrow<string>('CSRF_SECRET'),
      // DD-2: the token is deliberately NOT bound to a session id. `saveUninitialized: false`
      // means `GET /auth/system/csrf` has no stable `req.sessionID`, so binding would 403 every
      // login. Security rests on the HMAC (CSRF_SECRET) plus an httpOnly cookie a foreign origin
      // can neither read nor write.
      getSessionIdentifier: () => '',
      cookieName: CSRF_COOKIE_NAME,
      cookieOptions: {
        httpOnly: true,
        path: '/',
        sameSite: resolveSameSite(
          this.config.get<string>('SESSION_COOKIE_SAMESITE'),
        ),
        secure: isCookieSecure(
          this.config.get<string>('SESSION_COOKIE_SECURE'),
        ),
      },
      size: 32,
      // GET/HEAD never require a token (AC-17); OPTIONS keeps CORS preflight alive.
      ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
      getTokenFromRequest: (req: Request) => req.headers['x-csrf-token'],
    });
  }

  /** Mints a token and sets the signed `eb.csrf` cookie. */
  generateToken(req: Request, res: Response): string {
    return this.csrf.generateToken(req, res);
  }

  get invalidCsrfTokenError(): Error {
    return this.csrf.invalidCsrfTokenError;
  }

  /** The protection middleware, with the two exemption lists applied. */
  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) =>
      isCsrfExempt(req.path)
        ? next()
        : this.csrf.doubleCsrfProtection(req, res, next);
  }
}

/**
 * Translates a CSRF rejection into the standard Nest error envelope.
 *
 * Required because the CSRF middleware runs via `app.use()`, and a raw-express `next(err)` never
 * reaches Nest's exception filters. Runs before the router, so a missing token on
 * `POST /auth/system/login` short-circuits with `403` and no session is ever created (AC-15).
 */
export const csrfErrorHandler =
  (csrf: CsrfService): ErrorRequestHandler =>
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (err === csrf.invalidCsrfTokenError || code === 'EBADCSRFTOKEN') {
      res.status(403).json({
        statusCode: 403,
        message: INVALID_CSRF_TOKEN,
        error: 'Forbidden',
      });
      return;
    }
    next(err);
  };
