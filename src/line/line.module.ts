import { Module } from '@nestjs/common';
import { LineController } from './line.controller';
import { LineService } from './line.service';
import { LineSignatureGuard } from './line-signature.guard';
import { LineUserController } from './line-user.controller';
import { LineUsersController } from './line-users.controller';
import { LineUserService } from './line-user.service';
import { LineWebhookService } from './line-webhook.service';

@Module({
  controllers: [LineController, LineUserController, LineUsersController],
  providers: [
    LineService,
    LineWebhookService,
    LineUserService,
    LineSignatureGuard,
  ],
  exports: [LineService, LineUserService],
})
export class LineModule {}
