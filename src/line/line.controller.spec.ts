import { Test, TestingModule } from '@nestjs/testing';
import type { webhook } from '@line/bot-sdk';
import { LineController } from './line.controller';
import { LineSignatureGuard } from './line-signature.guard';
import { LineWebhookService } from './line-webhook.service';

describe('LineController', () => {
  let controller: LineController;
  const handleEvents = jest.fn();

  beforeEach(async () => {
    handleEvents.mockReset().mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LineController],
      providers: [{ provide: LineWebhookService, useValue: { handleEvents } }],
    })
      // The signature guard is unit-tested separately; bypass it here.
      .overrideGuard(LineSignatureGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<LineController>(LineController);
  });

  it('dispatches events and returns ok', async () => {
    const body = {
      destination: 'x',
      events: [{ type: 'follow' }],
    } as unknown as webhook.CallbackRequest;

    const result = await controller.handleWebhook(body);

    expect(handleEvents).toHaveBeenCalledWith(body.events);
    expect(result).toEqual({ ok: true });
  });

  it('tolerates a body without events', async () => {
    const result = await controller.handleWebhook({
      destination: 'x',
    } as unknown as webhook.CallbackRequest);

    expect(handleEvents).toHaveBeenCalledWith([]);
    expect(result).toEqual({ ok: true });
  });
});
