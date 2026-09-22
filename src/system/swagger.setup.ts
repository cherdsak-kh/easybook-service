import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { DEFAULT_SESSION_COOKIE_NAME } from '../session/session.middleware';
import { SwaggerGateService } from './swagger-gate.service';

/** Every path `SwaggerModule.setup('docs', …)` serves. `/docs` also covers `/docs/<asset>`. */
export const SWAGGER_PATHS = ['/docs', '/docs-json', '/docs-yaml'] as const;

/**
 * Builds the OpenAPI document and serves it at `/docs` (UI) and `/docs-json`, behind the runtime
 * gate (`INTEGRATIONS-API-1`).
 *
 * ⚠️ ALWAYS MOUNTED NOW. `SWAGGER_ENABLED=false` used to skip this entirely; now the routes exist
 * and `SwaggerGateService` decides per request, so a SUPER_ADMIN can turn them on and off without a
 * restart. The env var only sets the default when no stored decision exists.
 *
 * ⚠️ ORDER IS LOAD-BEARING, TWICE:
 *   · the gate middleware is registered BEFORE `SwaggerModule.setup`, or Swagger's own handlers
 *     answer first and the gate never runs;
 *   · all of this must happen BEFORE `app.init()`. Nest registers its catch-all 404 at init, and a
 *     route added afterwards sits behind it, unreachable. `main.ts` calls this before `listen()`;
 *     the e2e app calls it from `createE2eApp`'s `beforeInit` hook.
 */
export function mountSwagger(app: INestApplication): void {
  const config = app.get(ConfigService);
  const gate = app.get(SwaggerGateService);
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
    // The LINE ID token (Bearer) that authenticates the LIFF-client endpoints
    // (`/line-users/register`, `/line-users/status`); referenced by @ApiBearerAuth().
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .build();

  app.use([...SWAGGER_PATHS], gate.middleware());
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);
}
