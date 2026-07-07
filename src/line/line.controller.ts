import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { webhook } from '@line/bot-sdk';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookService } from './line-webhook.service';

/** LINE Messaging API webhook. Not part of the public REST contract. */
@ApiExcludeController()
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
