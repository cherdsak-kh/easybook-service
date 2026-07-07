import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  const queryRaw = jest.fn();

  beforeEach(async () => {
    queryRaw.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns ok with uptime, timestamp and db "up" when the DB responds', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const result = await controller.check();
    expect(result.status).toBe('ok');
    expect(typeof result.uptime).toBe('number');
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(result.db).toBe('up');
  });

  it('reports db "down" when the DB probe fails', async () => {
    queryRaw.mockRejectedValue(new Error('no connection'));
    const result = await controller.check();
    expect(result.status).toBe('ok');
    expect(result.db).toBe('down');
  });
});
