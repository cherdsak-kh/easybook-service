import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthResponseDto } from './dto/health-response.dto';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  const check = jest.fn();

  beforeEach(async () => {
    check.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { check } }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns the readiness snapshot from the service (200 path)', async () => {
    const snapshot: HealthResponseDto = {
      status: 'ok',
      uptime: 12.34,
      timestamp: new Date().toISOString(),
      db: 'up',
      redis: 'up',
    };
    check.mockResolvedValue(snapshot);

    await expect(controller.check()).resolves.toEqual(snapshot);
  });

  it('propagates the service 503 so Nest maps it to Service Unavailable', async () => {
    check.mockRejectedValue(
      new ServiceUnavailableException({
        status: 'error',
        db: 'down',
        redis: 'up',
      }),
    );

    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
