import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('returns the welcome banner with the contracted message and status', () => {
    const info = controller.getInfo();

    expect(info.message).toBe('EasyBook API is running');
    expect(info.status).toBe('active');
  });

  it('stamps a valid ISO-8601 timestamp reflecting the current time', () => {
    const before = Date.now();
    const { timestamp } = controller.getInfo();
    const after = Date.now();

    // Parseable, and round-trips exactly as a canonical ISO string.
    const parsed = new Date(timestamp);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe(timestamp);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // It is "now", not a hard-coded constant.
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before);
    expect(parsed.getTime()).toBeLessThanOrEqual(after);
  });
});
