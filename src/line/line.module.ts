import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { LineController } from './line.controller';
import { LineService } from './line.service';
import { LineSignatureGuard } from './line-signature.guard';
import { LineRegistrationController } from './line-registration.controller';
import { LineUsersController } from './line-users.controller';
import { LineUserService } from './line-user.service';
import { LineWebhookService } from './line-webhook.service';
import { LineIdTokenGuard } from './guards/line-id-token.guard';

@Module({
  // `RealtimeModule` only provides the gateway `LineUserService` emits through; the graph stays
  // acyclic (Realtime depends on the global Prisma/Config/Redis modules only), so no `forwardRef`.
  imports: [RealtimeModule],
  // Route-order is LOAD-BEARING (SC-6): the client `LineRegistrationController` MUST precede the
  // admin `LineUsersController` so its literal `PATCH /line-users/registration` route is registered
  // before — and therefore wins over — the admin `PATCH /line-users/:id`. A real cuid still falls
  // through to `:id`. Reordering these two breaks the client self-edit endpoint.
  controllers: [
    LineController,
    LineRegistrationController,
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
