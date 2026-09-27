import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { webhook } from '@line/bot-sdk';
import { NoErrorNotification } from '../notifications/triggers/no-error-notification.decorator';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookService } from './line-webhook.service';

/**
 * LINE Messaging API webhook. Not part of the public REST contract.
 *
 * `@NoErrorNotification()` (C5 exclusion, design §2.7): LINE retries the whole webhook delivery on
 * a non-2xx/exception response, and `LineWebhookService.handleEvents` already catches each event's
 * failure independently — a second alarm from the global interceptor would be noise, not signal.
 */
@ApiExcludeController()
@NoErrorNotification()
@Controller('line')
export class LineController {
  constructor(private readonly webhook: LineWebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  @UseGuards(LineSignatureGuard)
  async handleWebhook(
    @Body() body: webhook.CallbackRequest,
  ): Promise<{ ok: true }> {
    await this.webhook.handleEvents(body.events ?? []);
    return { ok: true };
  }
}
