import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { metricDayOf, RequestMetrics } from './request-metrics';

class FakePipeline {
  ops: string[][] = [];
  incr(k: string) {
    this.ops.push(['incr', k]);
    return this;
  }
  incrby(k: string, n: number) {
    this.ops.push(['incrby', k, String(n)]);
    return this;
  }
  expire(k: string, s: number) {
    this.ops.push(['expire', k, String(s)]);
    return this;
  }
  exec = jest.fn(() => Promise.resolve([]));
}

class FakeRedis extends EventEmitter {
  status = 'ready';
  pipelines: FakePipeline[] = [];
  store = new Map<string, string>();
  pipeline() {
    const p = new FakePipeline();
    this.pipelines.push(p);
    return p;
  }
  mget(keys: string[]) {
    return Promise.resolve(keys.map((k) => this.store.get(k) ?? null));
  }
}

const make = () => {
  const redis = new FakeRedis();
  const metrics = new RequestMetrics(redis as unknown as Redis, 'eb:test:');
  return { redis, metrics };
};

describe('RequestMetrics', () => {
  describe('metricDayOf (Bangkok day)', () => {
    it.each([
      ['2026-09-30T16:59:59Z', '20260930'], // 23:59:59 +07
      ['2026-09-30T17:00:00Z', '20261001'], // 00:00:00 +07 the next day
      ['2026-12-31T17:00:00Z', '20270101'],
    ])('%s -> %s', (iso, day) => {
      expect(metricDayOf(new Date(iso))).toBe(day);
    });
  });

  it('increments the request counter, and the 5xx counter only for a 5xx, each with a 100-day TTL', () => {
    const { redis, metrics } = make();
    const at = new Date('2026-10-03T03:00:00Z');
    metrics.count(at, false);
    metrics.count(at, true);
    const [ok, bad] = redis.pipelines;
    expect(ok.ops).toEqual([
      ['incr', 'eb:test:metrics:req:20261003'],
      ['expire', 'eb:test:metrics:req:20261003', String(100 * 86400)],
    ]);
    expect(bad.ops).toEqual([
      ['incr', 'eb:test:metrics:req:20261003'],
      ['expire', 'eb:test:metrics:req:20261003', String(100 * 86400)],
      ['incr', 'eb:test:metrics:5xx:20261003'],
      ['expire', 'eb:test:metrics:5xx:20261003', String(100 * 86400)],
    ]);
  });

  it('accumulates in memory while Redis is down and adds the deltas back on ready', () => {
    const { redis, metrics } = make();
    redis.status = 'reconnecting';
    const at = new Date('2026-10-03T03:00:00Z');
    metrics.count(at, false);
    metrics.count(at, true);
    metrics.count(at, true);
    expect(redis.pipelines).toHaveLength(0);

    redis.status = 'ready';
    redis.emit('ready');
    expect(redis.pipelines).toHaveLength(1);
    expect(redis.pipelines[0].ops).toEqual([
      ['incrby', 'eb:test:metrics:req:20261003', '3'],
      ['expire', 'eb:test:metrics:req:20261003', String(100 * 86400)],
      ['incrby', 'eb:test:metrics:5xx:20261003', '2'],
      ['expire', 'eb:test:metrics:5xx:20261003', String(100 * 86400)],
    ]);

    redis.emit('ready'); // nothing left to flush
    expect(redis.pipelines).toHaveLength(1);
  });

  it('never throws from count(), even when the pipeline is broken', () => {
    const { redis, metrics } = make();
    redis.pipeline = () => {
      throw new Error('boom');
    };
    expect(() => metrics.count(new Date(), true)).not.toThrow();
  });

  describe('read', () => {
    it('sums the counters and counts days with no request counter', async () => {
      const { redis, metrics } = make();
      redis.store.set('eb:test:metrics:req:20261001', '1000');
      redis.store.set('eb:test:metrics:5xx:20261001', '4');
      redis.store.set('eb:test:metrics:req:20261003', '500');
      const out = await metrics.read([
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
      ]);
      expect(out).toEqual({ requests: 1500, failed: 4, daysWithoutData: 1 });
    });

    it('is all zero for an empty list', async () => {
      const { metrics } = make();
      expect(await metrics.read([])).toEqual({
        requests: 0,
        failed: 0,
        daysWithoutData: 0,
      });
    });
  });
});
