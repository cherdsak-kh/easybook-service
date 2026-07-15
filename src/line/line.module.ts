import { Module } from '@nestjs/common';
import { LineController } from './line.controller';
import { LineService } from './line.service';
import { LineSignatureGuard } from './line-signature.guard';
import { LineRegistrationController } from './line-registration.controller';
import { LineUsersController } from './line-users.controller';
import { LineUserService } from './line-user.service';
import { LineWebhookService } from './line-webhook.service';
import { LineIdTokenGuard } from './guards/line-id-token.guard';

@Module({
  controllers: [
    LineController,
    LineUsersController,
    LineRegistrationController,
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
