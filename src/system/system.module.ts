import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LineModule } from '../line/line.module';
import { StorageModule } from '../storage/storage.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { SupportController } from './support.controller';
import { SupportRelayService } from './support-relay.service';
import {
  FetchSupportWebhookTransport,
  SupportWebhookTransport,
} from './support-webhook.transport';
import { SwaggerGateService } from './swagger-gate.service';
import { SystemController } from './system.controller';
import { SystemHealthController } from './system-health.controller';
import { SystemHealthService } from './system-health.service';

/**
 * Build metadata for the version screen, การเชื่อมต่อระบบ (`INTEGRATIONS-API-1`), and — Reports
 * Phase 1 — role-shaped infrastructure health (`GET /system/health`, design §2.4).
 *
 * `AuthModule` for `SessionGuard` / `RolesGuard`. `LineModule` for its exported `LineService` and
 * `LineCredentialsService` — never re-provided here: there is ONE `LineService` in the app, and the
 * e2e suites replace its client at the module boundary. `StorageModule` for `R2StorageService`.
 * Prisma, Config and Redis are global. No cycle: nothing under Line or Storage imports this module.
 *
 * `SystemHealthController` lives HERE rather than in `src/reports/` (which is otherwise the home of
 * Reports Phase 1): it reuses exactly the same `LineModule`/`StorageModule` dependencies
 * `IntegrationsService` already has, and `src/reports/` was designed to stay isolated from every
 * write-heavy or infrastructure-probing module (design §2.1, §5).
 *
 * `SwaggerGateService` is exported because `mountSwagger` resolves it from the app (`app.get`).
 */
@Module({
  imports: [forwardRef(() => AuthModule), LineModule, StorageModule],
  controllers: [
    SystemController,
    IntegrationsController,
    SystemHealthController,
    SupportController,
  ],
  providers: [
    SwaggerGateService,
    IntegrationsService,
    SystemHealthService,
    SupportRelayService,
    // The outbound-HTTP seam: the e2e suite overrides this token so no test can reach Discord.
    {
      provide: SupportWebhookTransport,
      useClass: FetchSupportWebhookTransport,
    },
  ],
  exports: [SwaggerGateService],
})
export class SystemModule {}
