import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Request, Response } from 'express';
import morgan from 'morgan';
import pc from 'picocolors';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { DEFAULT_SESSION_COOKIE_NAME } from './session/session.middleware';

// The staging deployment sits behind a fixed 2-proxy chain: Cloudflare -> Nginx -> app.
// Express must trust exactly that many hops to resolve the true client IP.
const DEFAULT_TRUST_PROXY_HOPS = 2;

// Dedicated Nest logger context for HTTP access logs. Piping morgan through Logger (not
// console.log) makes every line carry Nest's own `[Nest] PID  - date  LOG [Morgan]` prefix,
// coloured by Logger itself — so morgan only ever produces the payload after `[Morgan] `.
const morganLogger = new Logger('Morgan');

// Colour the status code by class: <400 (2xx/3xx) green, 4xx yellow, 5xx red. Tolerates a
// missing/undefined status (e.g. the socket dropped before a response) without throwing.
function colorizeStatus(status: string | undefined): string {
  if (!status) {
    return pc.gray('-');
  }
  const code = Number(status);
  if (code >= 500) {
    return pc.red(status);
  }
  if (code >= 400) {
    return pc.yellow(status);
  }
  return pc.green(status);
}

/**
 * Number of reverse-proxy hops Express should trust when reading `X-Forwarded-For`.
 *
 * A NUMBER (hop count) is used rather than a blanket `true`: `true` trusts the entire chain,
 * so any client could spoof `X-Forwarded-For` and have Express treat the forged left-most
 * entry as its IP — collapsing or evading the per-IP login rate limiter. A hop count trusts
 * only the fixed proxies actually in front of the app (Cloudflare + Nginx = 2), so
 * `req.ip`/`req.ips` resolve to the genuine client and the limiter buckets per user.
 * Env-overridable (`TRUST_PROXY_HOPS`) for other topologies; `0` disables proxy trust for
 * direct/local runs. An invalid value falls back to the default rather than failing boot —
 * a mis-set hop count is an operational nit, not a deploy-blocking secret defect.
 */
function resolveTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_TRUST_PROXY_HOPS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    new Logger('Bootstrap').warn(
      `Invalid TRUST_PROXY_HOPS="${raw}"; falling back to ${DEFAULT_TRUST_PROXY_HOPS}.`,
    );
    return DEFAULT_TRUST_PROXY_HOPS;
  }
  return parsed;
}

async function bootstrap() {
  // rawBody: true preserves req.rawBody so the LINE webhook signature can be
  // verified (HMAC over the exact bytes) even after JSON parsing. Typed as
  // NestExpressApplication so `app.set('trust proxy', ...)` is available below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const config = app.get(ConfigService);

  // Trust the fixed reverse-proxy chain (Cloudflare -> Nginx -> app) so req.ip / req.ips —
  // and therefore the login rate limiter (which reads req.ips first) — see the real client
  // IP instead of the Nginx socket address. Set before any middleware runs.
  const trustProxyHops = resolveTrustProxyHops(
    config.get<string>('TRUST_PROXY_HOPS'),
  );
  app.set('trust proxy', trustProxyHops);

  // HTTP request logging — mounted here (not in the shared app.setup) on purpose: keeping it
  // out of configureApp() means the 62 e2e requests never spam the test terminal. Registered
  // before configureApp() so it is the FIRST middleware in the chain and logs every request,
  // including ones later rejected by the session/CSRF layers (it writes on the response
  // 'finish' event, so it always captures the final status code). morgan reads request/response
  // metadata only — it never consumes the body stream — so it is inert w.r.t. rawBody and the
  // LINE webhook's HMAC over the raw bytes.
  //
  // The 'dev' preset is replaced by a custom format function so the line reads
  // `METHOD URL STATUS TIME ms - IP: <clientIp>` (IP pushed to the end to keep the columns
  // left-aligned), routed through the Nest logger's stream. Only the payload is colourised;
  // the `[Nest] … LOG [Morgan]` prefix is produced and coloured by Logger itself.
  app.use(
    morgan<Request, Response>(
      (tokens, req, res) => {
        const method = tokens.method(req, res) ?? '';
        const url = tokens.url(req, res) ?? '';
        const time = tokens['response-time'](req, res) ?? '-';
        // Proxy-safe client IP: prefer the X-Forwarded-For chain (surfaced in req.ips when
        // `trust proxy` is set), else the socket IP; never throw if both are absent.
        const ip =
          (req.ips && req.ips.length ? req.ips[0] : req.ip) ?? 'unknown';

        return [
          pc.cyan(method),
          url,
          colorizeStatus(tokens.status(req, res)),
          pc.yellow(`${time} ms`),
          pc.dim(`- IP: ${ip}`),
        ].join(' ');
      },
      {
        stream: {
          write: (msg: string) => {
            morganLogger.log(msg.trim());
          },
        },
      },
    ),
  );

  // CORS, global prefix, cookie-parser, session, CSRF, validation — order matters (see app.setup).
  configureApp(app);

  // OpenAPI / Swagger UI at /docs (raw spec at /docs-json). Can be disabled in prod.
  if (config.get<string>('SWAGGER_ENABLED', 'true') !== 'false') {
    const sessionCookie = config.get<string>(
      'SESSION_COOKIE_NAME',
      DEFAULT_SESSION_COOKIE_NAME,
    );
    const swaggerConfig = new DocumentBuilder()
      .setTitle('EasyBook API')
      .setDescription('REST contract for the EasyBook booking service.')
      .setVersion('v1')
      .addCookieAuth(
        sessionCookie,
        { type: 'apiKey', in: 'cookie', name: sessionCookie },
        // The security-scheme name referenced by @ApiCookieAuth('session').
        'session',
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  const port = config.get<number>('PORT', 3300);
  await app.listen(port);
}

void bootstrap();
