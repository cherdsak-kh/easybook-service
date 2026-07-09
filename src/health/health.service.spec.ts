import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { HealthResponseDto } from './dto/health-response.dto';
import { HealthService } from './health.service';

/**
 * Readiness-gate contract (mocked Prisma + Redis — no live services):
 *   both deps up   -> resolves, status 'ok'  (controller answers 200)
 *   DB down        -> throws 503, db 'down'
 *   Redis down     -> throws 503, redis 'down'
 */
describe('HealthService', () => {
  let service: HealthService;
  const queryRaw = jest.fn();
  const isHealthy = jest.fn();

  beforeEach(async () => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    isHealthy.mockReset().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        { provide: RedisService, useValue: { isHealthy } },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('resolves 200-shaped body when BOTH the DB and Redis are up', async () => {
    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.db).toBe('up');
    expect(result.redis).toBe('up');
    expect(typeof result.uptime).toBe('number');
    expect(() => new Date(result.timestamp)).not.toThrow();
  });

  it('throws 503 with db "down" when the DB probe fails', async () => {
    queryRaw.mockRejectedValue(new Error('no connection'));

    const error = await service.check().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const exception = error as ServiceUnavailableException;
    expect(exception.getStatus()).toBe(503);
    const body = exception.getResponse() as HealthResponseDto;
    expect(body.status).toBe('error');
    expect(body.db).toBe('down');
    expect(body.redis).toBe('up');
  });

  it('throws 503 with redis "down" when Redis is unreachable', async () => {
    isHealthy.mockResolvedValue(false);

    const error = await service.check().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const exception = error as ServiceUnavailableException;
    expect(exception.getStatus()).toBe(503);
    const body = exception.getResponse() as HealthResponseDto;
    expect(body.status).toBe('error');
    expect(body.db).toBe('up');
    expect(body.redis).toBe('down');
  });

  it('throws 503 when BOTH dependencies are down', async () => {
    queryRaw.mockRejectedValue(new Error('no connection'));
    isHealthy.mockResolvedValue(false);

    const error = await service.check().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const exception = error as ServiceUnavailableException;
    expect(exception.getStatus()).toBe(503);
    const body = exception.getResponse() as HealthResponseDto;
    expect(body.db).toBe('down');
    expect(body.redis).toBe('down');
  });
});
