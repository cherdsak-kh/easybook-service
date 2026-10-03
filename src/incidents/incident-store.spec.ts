import type { Redis } from 'ioredis';
import { IncidentStore, summaryOf } from './incident-store';
import {
  IncidentCallerKind,
  IncidentComponent,
  IncidentSeverity,
  type IncidentDetailRecord,
  type IncidentDraftRecord,
} from './incident.types';

const draft = (
  over: Partial<IncidentDraftRecord> = {},
): IncidentDraftRecord => ({
  traceId: 'tr-0123456789abcdef',
  atMs: 1_759_500_000_000,
  severity: IncidentSeverity.ERROR,
  component: IncidentComponent.API,
  status: 500,
  method: 'GET',
  routeTemplate: '/api/v1/x',
  path: '/api/v1/x',
  queryKeys: [],
  errorCode: 'Error',
  message: 'boom',
  stack: 'Error: boom\n    at x (/srv/x.js:1:1)',
  caller: { kind: IncidentCallerKind.ANONYMOUS, label: 'anonymous' },
  ip: '203.0.113.7',
  userAgent: 'jest',
  context: {},
  ...over,
});

const detailOf = (
  seq: number,
  over: Partial<IncidentDraftRecord> = {},
): IncidentDetailRecord => ({
  ...draft(over),
  id: `ERR-${over.status ?? 500}-${String(seq).padStart(4, '0')}`,
  seq,
});

function fakeRedis() {
  const calls: unknown[][] = [];
  let seq = 0;
  const redis = {
    defineCommand: jest.fn(),
    incr: jest.fn(() => Promise.resolve(++seq)),
    incidentAdd: jest.fn((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(1);
    }),
    incidentPurge: jest.fn(() => Promise.resolve(3)),
    lrange: jest.fn(),
    hget: jest.fn(),
  };
  return { redis, calls };
}

describe('IncidentStore', () => {
  it('registers both Lua commands with two keys each', () => {
    const { redis } = fakeRedis();
    new IncidentStore(redis as unknown as Redis, 'eb:');
    expect(redis.defineCommand).toHaveBeenCalledWith('incidentAdd', {
      numberOfKeys: 2,
      lua: expect.stringContaining("redis.call('LPUSH'") as string,
    });
    expect(redis.defineCommand).toHaveBeenCalledWith('incidentPurge', {
      numberOfKeys: 2,
      lua: expect.stringContaining("redis.call('LRANGE'") as string,
    });
  });

  it('uses the intended key names under the production root', () => {
    const { redis } = fakeRedis();
    const store = new IncidentStore(redis as unknown as Redis, 'eb:');
    expect(store.ringKey).toBe('eb:incident:ring');
    expect(store.detailKey).toBe('eb:incident:detail');
    expect(store.seqKey).toBe('eb:incident:seq');
    expect(store.ringKey.startsWith('eb:cache:')).toBe(false); // never RedisService's cache prefix
  });

  it('uses the test root so an e2e run never touches the dev log', () => {
    const { redis } = fakeRedis();
    const store = new IncidentStore(redis as unknown as Redis, 'eb:test:');
    expect(store.ringKey).toBe('eb:test:incident:ring');
  });

  it('mints ERR-<status>-<seq padded to 4> and ERR-SYS for a request-less incident', async () => {
    const { redis } = fakeRedis();
    const store = new IncidentStore(redis as unknown as Redis, 'eb:');
    expect(await store.add(draft({ status: 500 }))).toBe('ERR-500-0001');
    expect(await store.add(draft({ status: 502 }))).toBe('ERR-502-0002');
    expect(await store.add(draft({ status: null }))).toBe('ERR-SYS-0003');
  });

  it('passes the cap, the age cap and a TTL to the add script, with a stack-free summary', async () => {
    const { redis, calls } = fakeRedis();
    const store = new IncidentStore(redis as unknown as Redis, 'eb:', {
      cap: 50,
      maxAgeDays: 7,
    });
    await store.add(draft());
    const [
      ring,
      detail,
      id,
      atMs,
      summaryJson,
      detailJson,
      cap,
      maxAgeMs,
      ,
      ttlMs,
    ] = calls[0];
    expect([ring, detail, id, atMs, cap, maxAgeMs, ttlMs]).toEqual([
      'eb:incident:ring',
      'eb:incident:detail',
      'ERR-500-0001',
      '1759500000000',
      50,
      7 * 86_400_000,
      7 * 86_400_000,
    ]);
    const summary = JSON.parse(summaryJson as string) as Record<
      string,
      unknown
    >;
    expect(summary).not.toHaveProperty('stack');
    expect(summary).not.toHaveProperty('context');
    expect(summary).not.toHaveProperty('userAgent');
    expect(JSON.parse(detailJson as string)).toHaveProperty('stack');
  });

  it('defaults to a 5,000-entry, 90-day ring', async () => {
    const { redis, calls } = fakeRedis();
    await new IncidentStore(redis as unknown as Redis, 'eb:').add(draft());
    expect(calls[0][6]).toBe(5000);
    expect(calls[0][7]).toBe(90 * 86_400_000);
  });

  it('rejects when Redis rejects (the recorder, not the store, handles that)', async () => {
    const { redis } = fakeRedis();
    redis.incr.mockRejectedValueOnce(new Error('down'));
    await expect(
      new IncidentStore(redis as unknown as Redis, 'eb:').add(draft()),
    ).rejects.toThrow('down');
  });

  describe('list', () => {
    it('parses, drops entries past the age cap and entries that are corrupt, newest first', async () => {
      const { redis } = fakeRedis();
      const now = 1_759_500_000_000;
      const day = 86_400_000;
      redis.lrange.mockResolvedValue([
        JSON.stringify(summaryOf(detailOf(1, { atMs: now - 100 * day }))), // past 90 d
        '{not json',
        JSON.stringify(summaryOf(detailOf(2, { atMs: now - 2 * day }))),
        JSON.stringify(summaryOf(detailOf(4, { atMs: now - day }))),
        JSON.stringify(summaryOf(detailOf(3, { atMs: now - day }))),
      ]);
      const store = new IncidentStore(redis as unknown as Redis, 'eb:');
      const out = await store.list(now);
      expect(out.map((r) => r.seq)).toEqual([4, 3, 2]); // (atMs desc, seq desc)
      expect(redis.lrange).toHaveBeenCalledWith('eb:incident:ring', 0, -1);
    });
  });

  describe('detail', () => {
    it('returns the parsed record, null when absent, null when corrupt', async () => {
      const { redis } = fakeRedis();
      const store = new IncidentStore(redis as unknown as Redis, 'eb:');
      redis.hget.mockResolvedValueOnce(JSON.stringify(detailOf(7)));
      expect((await store.detail('ERR-500-0007'))?.seq).toBe(7);
      redis.hget.mockResolvedValueOnce(null);
      expect(await store.detail('ERR-500-0008')).toBeNull();
      redis.hget.mockResolvedValueOnce('{oops');
      expect(await store.detail('ERR-500-0009')).toBeNull();
    });
  });

  it('purgeBefore returns what the script reports', async () => {
    const { redis } = fakeRedis();
    const store = new IncidentStore(redis as unknown as Redis, 'eb:');
    await expect(store.purgeBefore(123)).resolves.toBe(3);
    expect(redis.incidentPurge).toHaveBeenCalledWith(
      'eb:incident:ring',
      'eb:incident:detail',
      123,
      90 * 86_400_000,
    );
  });
});
