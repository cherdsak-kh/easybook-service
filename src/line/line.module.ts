import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { VenuesModule } from '../venues/venues.module';
import { LineController } from './line.controller';
import { LineService } from './line.service';
import { LineSignatureGuard } from './line-signature.guard';
import { LineRegistrationController } from './line-registration.controller';
import { LineSettingsController } from './line-settings.controller';
import { LineUsersController } from './line-users.controller';
import { LineUserService } from './line-user.service';
import { LineWebhookService } from './line-webhook.service';
import { LineIdTokenGuard } from './guards/line-id-token.guard';

@Module({
  // `RealtimeModule` only provides the gateway `LineUserService` emits through; the graph stays
  // acyclic (Realtime depends on the global Prisma/Config/Redis modules only), so no `forwardRef`.
  //
  // `VenuesModule` is imported for its exported `VenuesService` alone (CLIENT-VENUES-1) — the
  // consumer venue reads on `LineRegistrationController` delegate to it. Still acyclic and still no
  // `forwardRef`: VenuesModule pulls in AuthModule + StorageModule, and nothing in either reaches
  // back to LineModule (app.module.ts is its only other importer).
  //
  // ⚠️ IMPORTING THE MODULE DOES NOT IMPORT ITS GUARD. `VenuesController` keeps its class-level
  // `@UseGuards(SessionGuard, RolesGuard)` and stays admin-only; what crosses this boundary is the
  // service, and the consumer routes put `LineIdTokenGuard` in front of it themselves.
  imports: [RealtimeModule, VenuesModule],
  // Route-order is LOAD-BEARING (SC-6): the client `LineRegistrationController` MUST precede the
  // admin `LineUsersController` so its literal `PATCH /line-users/registration` route is registered
  // before — and therefore wins over — the admin `PATCH /line-users/:id`. A real cuid still falls
  // through to `:id`. Reordering these two breaks the client self-edit endpoint.
  //
  // `LineSettingsController` (Phase 7a) sits between them for exactly the same reason and it is NOT
  // cosmetic: its `PATCH /line-users/settings` is a 2-segment PATCH, and `settings` is a perfectly
  // good `:id` as far as Express is concerned. Registered after the admin controller, every settings
  // save would be routed into the admin access-change handler instead.
  controllers: [
    LineController,
    LineRegistrationController,
    LineSettingsController,
    LineUsersController,
  ],
  providers: [
    LineService,
    LineWebhookService,
    LineUserService,
    LineSignatureGuard,
    LineIdTokenGuard,
  ],
  exports: [LineService, LineUserService],
})
export class LineModule {}
