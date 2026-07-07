import { Module } from '@nestjs/common';
import { LineController } from './line.controller';
import { LineService } from './line.service';
import { LineSignatureGuard } from './line-signature.guard';
import { LineUserController } from './line-user.controller';
import { LineUserService } from './line-user.service';
import { LineWebhookService } from './line-webhook.service';

@Module({
  controllers: [LineController, LineUserController],
  providers: [
    LineService,
    LineWebhookService,
    LineUserService,
    LineSignatureGuard,
  ],
  exports: [LineService, LineUserService],
})
export class LineModule {}
