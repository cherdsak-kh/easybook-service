import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import type { Redis } from 'ioredis';
import { API_BASE_PATH } from './common/api.constants';
import { CsrfService, csrfErrorHandler } from './csrf/csrf.service';
import { REDIS_CLIENT } from './redis/redis.constants';
import {
  createSessionMiddleware,
  sessionExemptWrapper,
  sessionStoreErrorHandler,
} from './session/session.middleware';

/**
 * The one place the HTTP pipeline is assembled. `main.ts` and the e2e specs both call it, so the
 * tests exercise the production wiring rather than a hand-rolled approximation.
 *
 * **Order is load-bearing.** Every `app.use()` below is registered after Nest's body parser
 * (installed during `NestFactory.create`) and before Nest's router (mounted during `app.init()`),
 * which is exactly the window the CSRF and session middlewares need.
 *
 * `rawBody: true` on `NestFactory.create` must stay: nothing here re-registers a body parser, so
 * `req.rawBody` still holds the exact bytes `LineSignatureGuard` HMACs. `POST /line/webhook` is
 * exempt from **both** session and CSRF — it is an external callback carrying no cookie, proven
 * authentic by its LINE signature.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const redis = app.get<Redis>(REDIS_CLIENT);
  const csrf = app.get(CsrfService);

  // 1. CORS first: preflight must not be intercepted, and error responses must carry CORS headers.
  //    With cookie sessions + `credentials: true` the allowlist is a security control, never `*`.
  //    `CORS_ORIGIN` may be a single origin or a comma-separated list (e.g. the Vite dev server
  //    plus a tunnel used for on-device LIFF testing); a list becomes an array of trimmed origins.
  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:2200');
  app.enableCors({
    origin: corsOrigin.includes(',')
      ? corsOrigin.split(',').map((origin) => origin.trim())
      : corsOrigin,
    credentials: true,
  });

  // 2. Versioned API surface. The root welcome banner (GET /) is excluded from the prefix so
  //    it answers at the bare origin (http://localhost:3300/) instead of 404-ing; everything
  //    else — /api/v1/health, /api/v1/line/webhook, etc. — stays under the prefix. `path: '/'`
  //    with RequestMethod.GET is the reliable form for excluding the root path specifically.
  app.setGlobalPrefix(API_BASE_PATH.replace(/^\//, ''), {
    exclude: [{ path: '/', method: RequestMethod.GET }],
  });

  // 3. cookie-parser — required by csrf-csrf.
  app.use(cookieParser());

  // 4. express-session, path-exempted (health + LINE webhook).
  app.use(sessionExemptWrapper(createSessionMiddleware(config, redis)));

  // 5. Session-store failure → 503. Fail closed; never a MemoryStore fallback.
  app.use(sessionStoreErrorHandler);

  // 6. CSRF (signed double-submit), LINE-webhook-exempted.
  app.use(csrf.middleware());

  // 7. CSRF failure → 403, in the standard Nest error envelope.
  app.use(csrfErrorHandler(csrf));

  // 8. DTO-driven validation at the transport boundary. `forbidNonWhitelisted` is what rejects
  //    every forbidden PATCH key — and it is why the CSRF token must be a header, not a body field.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
