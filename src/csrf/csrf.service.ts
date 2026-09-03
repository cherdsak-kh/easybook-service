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
 * ⚠️ MATCHED BY EXACT `req.path`, so every entry is a literal with no parameters. A route with a
 * path parameter cannot be exempted this way, which is a useful accident: the two GET availability
 * and venue reads need no entry because GETs are already ignored by method.
 */
export const CSRF_EXEMPT_PATHS: readonly string[] = [
  `${API_BASE_PATH}/line/webhook`,
  `${API_BASE_PATH}/line-users/register`,
  `${API_BASE_PATH}/line-users/registration`,
  `${API_BASE_PATH}/line-users/bookings`,
];

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

  /** The protection middleware, with the LINE webhook exempted (exact `req.path` match). */
  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) =>
      CSRF_EXEMPT_PATHS.includes(req.path)
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
