import { RedisService } from './redis.service';

/**
 * `RedisService.claimOnce` (`NOTIF-EVENTS-1` §2.6) — the C1/C5 dedupe primitive. Nothing else on
 * `RedisService` is covered here; the cache helpers are exercised end-to-end.
 */
describe('RedisService — claimOnce', () => {
  const client = { status: 'ready', set: jest.fn() };

  const service = () => new RedisService(client as never);

  beforeEach(() => {
    jest.clearAllMocks();
    client.status = 'ready';
  });

  it('ready: issues SET key 1 EX ttl NX under the eb:notif: prefix', async () => {
    client.set.mockResolvedValue('OK');
    const result = await service().claimOnce('c1:RATE_LIMITED', 3600);

    expect(result).toBe(true);
    expect(client.set).toHaveBeenCalledWith(
      'eb:notif:c1:RATE_LIMITED',
      '1',
      'EX',
      3600,
      'NX',
    );
  });

  it('ready: a null reply (already claimed) is false', async () => {
    client.set.mockResolvedValue(null);
    await expect(service().claimOnce('c1:RATE_LIMITED', 3600)).resolves.toBe(
      false,
    );
  });

  it('a throw falls back to the in-process map and still claims', async () => {
    client.set.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service().claimOnce('c5:x', 900)).resolves.toBe(true);
  });

  it('not ready: falls back without calling the client', async () => {
    client.status = 'down';
    const svc = service();
    await expect(svc.claimOnce('c1:TRANSIENT', 60)).resolves.toBe(true);
    expect(client.set).not.toHaveBeenCalled();
  });

  it('the fallback window: true, then false, then true again after the TTL', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    client.status = 'down';
    const svc = service();

    await expect(svc.claimOnce('k', 10)).resolves.toBe(true);
    await expect(svc.claimOnce('k', 10)).resolves.toBe(false);

    jest.advanceTimersByTime(11_000);
    await expect(svc.claimOnce('k', 10)).resolves.toBe(true);

    jest.useRealTimers();
  });

  it('the fallback is per key: a different key claims independently', async () => {
    client.status = 'down';
    const svc = service();
    await expect(svc.claimOnce('a', 60)).resolves.toBe(true);
    await expect(svc.claimOnce('b', 60)).resolves.toBe(true);
    await expect(svc.claimOnce('a', 60)).resolves.toBe(false);
  });
});
