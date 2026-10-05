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

/** Support relay primitives: both are NEVER-throw and answer `null` for "Redis unavailable". */
describe('RedisService — incrementSequence / incrementWindow', () => {
  const exec = jest.fn();
  const chain = {
    set: jest.fn().mockReturnThis(),
    incr: jest.fn().mockReturnThis(),
    exec,
  };
  const client = {
    status: 'ready',
    incr: jest.fn(),
    multi: jest.fn(() => chain),
  };

  const service = () => new RedisService(client as never);

  beforeEach(() => {
    jest.clearAllMocks();
    client.status = 'ready';
  });

  it('incrementSequence: INCR under eb:support: and returns the number', async () => {
    client.incr.mockResolvedValue(43);
    await expect(service().incrementSequence('incident-seq')).resolves.toBe(43);
    expect(client.incr).toHaveBeenCalledWith('eb:support:incident-seq');
  });

  it('incrementSequence: not ready -> null without calling the client', async () => {
    client.status = 'reconnecting';
    await expect(
      service().incrementSequence('incident-seq'),
    ).resolves.toBeNull();
    expect(client.incr).not.toHaveBeenCalled();
  });

  it('incrementSequence: a command error -> null, never a throw', async () => {
    client.incr.mockRejectedValue(new Error('boom'));
    await expect(
      service().incrementSequence('incident-seq'),
    ).resolves.toBeNull();
  });

  it('incrementWindow: SET 0 EX ttl NX then INCR in one MULTI, returns the INCR result', async () => {
    exec.mockResolvedValue([
      [null, 'OK'],
      [null, 3],
    ]);
    await expect(service().incrementWindow('rate:u1', 600)).resolves.toBe(3);
    expect(chain.set).toHaveBeenCalledWith(
      'eb:support:rate:u1',
      0,
      'EX',
      600,
      'NX',
    );
    expect(chain.incr).toHaveBeenCalledWith('eb:support:rate:u1');
  });

  it('incrementWindow: not ready -> null', async () => {
    client.status = 'end';
    await expect(service().incrementWindow('rate:u1', 600)).resolves.toBeNull();
    expect(client.multi).not.toHaveBeenCalled();
  });

  it('incrementWindow: exec rejects -> null', async () => {
    exec.mockRejectedValue(new Error('boom'));
    await expect(service().incrementWindow('rate:u1', 600)).resolves.toBeNull();
  });

  it('incrementWindow: a per-command error inside EXEC -> null', async () => {
    exec.mockResolvedValue([
      [null, 'OK'],
      [new Error('WRONGTYPE'), null],
    ]);
    await expect(service().incrementWindow('rate:u1', 600)).resolves.toBeNull();
  });

  it('incrementWindow: a null EXEC (aborted transaction) -> null', async () => {
    exec.mockResolvedValue(null);
    await expect(service().incrementWindow('rate:u1', 600)).resolves.toBeNull();
  });
});
