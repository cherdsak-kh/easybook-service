import {
  LoginLogPurgeCron,
  LOGIN_LOG_PURGE_CRON,
} from './login-log-purge.cron';
import type { LoginLogService } from './login-log.service';

describe('LoginLogPurgeCron', () => {
  const purgeExpired = jest.fn();
  let cron: LoginLogPurgeCron;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    cron = new LoginLogPurgeCron({
      purgeExpired,
    } as unknown as LoginLogService);
    const logger = (
      cron as unknown as { logger: { log: () => void; error: () => void } }
    ).logger;
    log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs daily at 03:30 — the exact string, so a weekly typo is caught', () => {
    expect(LOGIN_LOG_PURGE_CRON).toBe('30 3 * * *');
    const [minute, hour, dayOfMonth, month, dayOfWeek] =
      LOGIN_LOG_PURGE_CRON.split(' ');
    expect([minute, hour]).toEqual(['30', '3']);
    expect([dayOfMonth, month, dayOfWeek]).toEqual(['*', '*', '*']);
  });

  it('purges and logs the count only', async () => {
    purgeExpired.mockResolvedValue(12);
    await cron.purge();
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Login log purge finished. deleted=12');
  });

  it('swallows a failure — nothing may escape a cron tick', async () => {
    purgeExpired.mockRejectedValue(new Error('db down'));
    await expect(cron.purge()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
