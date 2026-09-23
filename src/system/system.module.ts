import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LineModule } from '../line/line.module';
import { StorageModule } from '../storage/storage.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { SwaggerGateService } from './swagger-gate.service';
import { SystemController } from './system.controller';

/**
 * Build metadata for the version screen, and การเชื่อมต่อระบบ (`INTEGRATIONS-API-1`).
 *
 * `AuthModule` for `SessionGuard` / `RolesGuard`. `LineModule` for its exported `LineService` and
 * `LineCredentialsService` — never re-provided here: there is ONE `LineService` in the app, and the
 * e2e suites replace its client at the module boundary. `StorageModule` for `R2StorageService`.
 * Prisma, Config and Redis are global. No cycle: nothing under Line or Storage imports this module.
 *
 * `SwaggerGateService` is exported because `mountSwagger` resolves it from the app (`app.get`).
 */
@Module({
  imports: [forwardRef(() => AuthModule), LineModule, StorageModule],
  controllers: [SystemController, IntegrationsController],
  providers: [SwaggerGateService, IntegrationsService],
  exports: [SwaggerGateService],
})
export class SystemModule {}
