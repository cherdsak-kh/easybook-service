import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { sessionIndexKey } from '../../redis/redis.constants';
import { SESSION_ABSOLUTE_MAX_AGE_MS } from '../auth.constants';
import { SessionTrackerService } from './session-tracker.service';
import { SESSION_INDEX_TTL_SECONDS } from './sessions.constants';

const SECRET = 'a-test-session-secret-that-is-long-enough-0123456789';
const IDLE_MS = 28_800_000; // the default 8 h
const NOW = 1_800_000_000_000;

type Reply = [Error | null, unknown];

/**
 * A tiny in-memory Redis: just the commands the tracker issues, with `multi()` / `pipeline()` chains
 * that behave like ioredis (a failed command is reported inside `exec()`'s array, not thrown).
 */
class FakeRedis {
  sets = new Map<string, Set<string>>();
  strings = new Map<string, { value: string; pttl: number }>();
  setTtl = new Map<string, number>();
  /** Every command that was issued, in order, as `[name, ...args]`. */
  log: unknown[][] = [];
  failExec: Error | null = null;
  failSmembers: Error | null = null;
  failSrem: Error | null = null;

  smembers = jest.fn((key: string): Promise<string[]> => {
    this.log.push(['smembers', key]);
    if (this.failSmembers) return Promise.reject(this.failSmembers);
    return Promise.resolve([...(this.sets.get(key) ?? [])]);
  });

  srem = jest.fn((key: string, ...members: string[]): Promise<number> => {
    this.log.push(['srem', key, ...members]);
    if (this.failSrem) return Promise.reject(this.failSrem);
    return Promise.resolve(this.apply('srem', [key, ...members]) as number);
  });

  multi = jest.fn(() => this.chain());
  pipeline = jest.fn(() => this.chain());

  private apply(name: string, args: unknown[]): unknown {
    switch (name) {
      case 'sadd': {
        const [key, ...members] = args as string[];
        const set = this.sets.get(key) ?? new Set<string>();
        members.forEach((m) => set.add(m));
        this.sets.set(key, set);
        return members.length;
      }
      case 'srem': {
        const [key, ...members] = args as string[];
        const set = this.sets.get(key);
        let removed = 0;
        members.forEach((m) => {
          if (set?.delete(m)) removed += 1;
        });
        return removed;
      }
      case 'expire': {
        this.setTtl.set(args[0] as string, args[1] as number);
        return 1;
      }
      case 'del':
        return this.strings.delete(args[0] as string) ? 1 : 0;
      case 'get':
        return this.strings.get(args[0] as string)?.value ?? null;
      case 'pttl':
        return this.strings.get(args[0] as string)?.pttl ?? -2;
      default:
        throw new Error(`unfaked command ${name}`);
    }
  }

  private chain() {
    const queued: Array<[string, unknown[]]> = [];
    const chain: Record<string, unknown> = {};
    for (const name of ['sadd', 'srem', 'expire', 'del', 'get', 'pttl']) {
      chain[name] = (...args: unknown[]) => {
        queued.push([name, args]);
        return chain;
      };
    }
    chain.exec = (): Promise<Reply[]> => {
      if (this.failExec) return Promise.reject(this.failExec);
      const replies: Reply[] = queued.map(([name, args]) => {
        this.log.push([name, ...args]);
        if (name === 'srem' && this.failSrem) return [this.failSrem, null];
        return [null, this.apply(name, args)];
      });
      return Promise.resolve(replies);
    };
    return chain as unknown;
  }

  /** Seeds a session key plus its index membership. */
  seedSession(
    userId: string,
    sid: string,
    body: Record<string, unknown> | string,
    pttl = IDLE_MS,
    indexed = true,
  ): void {
    this.strings.set(`eb:sess:${sid}`, {
      value: typeof body === 'string' ? body : JSON.stringify(body),
      pttl,
    });
    if (indexed) {
      const key = sessionIndexKey(userId);
      const set = this.sets.get(key) ?? new Set<string>();
      set.add(sid);
      this.sets.set(key, set);
    }
  }

  members(userId: string): string[] {
    return [...(this.sets.get(sessionIndexKey(userId)) ?? [])];
  }
}

const session = (userId: string, ageMs: number, extra = {}) => ({
  cookie: {},
  systemUserId: userId,
  createdAt: NOW - ageMs,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/129.0',
  ...extra,
});

describe('SessionTrackerService', () => {
  let redis: FakeRedis;
  let tracker: SessionTrackerService;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    redis = new FakeRedis();
    const config = {
      getOrThrow: () => SECRET,
      get: () => undefined,
    } as unknown as ConfigService;
    tracker = new SessionTrackerService(redis as unknown as Redis, config);
    // Keep the expected-failure logs out of the test output.
    jest
      .spyOn(
        (
          tracker as unknown as {
            logger: { error: () => void; warn: () => void };
          }
        ).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    jest
      .spyOn(
        (
          tracker as unknown as {
            logger: { error: () => void; warn: () => void };
          }
        ).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('track', () => {
    it('SADD + EXPIRE (>= 24 h) in ONE multi, with the index TTL re-armed', async () => {
      await tracker.track('u1', 'sid-1');

      expect(redis.multi).toHaveBeenCalledTimes(1);
      expect(redis.members('u1')).toEqual(['sid-1']);
      expect(redis.setTtl.get(sessionIndexKey('u1'))).toBe(
        SESSION_INDEX_TTL_SECONDS,
      );
      expect(SESSION_INDEX_TTL_SECONDS).toBeGreaterThanOrEqual(86_400);
    });

    it('removes the previous session of a re-login in the same MULTI', async () => {
      redis.seedSession('u1', 'old', session('u1', 1000));
      await tracker.track('u1', 'new', { userId: 'u1', sid: 'old' });

      expect(redis.multi).toHaveBeenCalledTimes(1);
      expect(redis.members('u1')).toEqual(['new']);
      // SREM first, then SADD, then EXPIRE.
      expect(redis.log.map((c) => c[0])).toEqual(['srem', 'sadd', 'expire']);
    });

    it("removes the previous sid from the PREVIOUS user's index when the login switches accounts", async () => {
      redis.seedSession('u-prev', 'old', session('u-prev', 1000));
      await tracker.track('u2', 'new', { userId: 'u-prev', sid: 'old' });

      expect(redis.members('u-prev')).toEqual([]);
      expect(redis.members('u2')).toEqual(['new']);
    });

    it('swallows a rejection — a login must not fail because only the index write failed (R-12)', async () => {
      redis.failExec = new Error('connection lost');
      await expect(tracker.track('u1', 'sid-1')).resolves.toBeUndefined();
    });

    it('swallows a per-command error reported inside exec()', async () => {
      redis.failSrem = new Error('READONLY');
      await expect(
        tracker.track('u1', 'sid-1', { userId: 'u1', sid: 'old' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('untrack', () => {
    it('SREMs the sid and swallows a rejection', async () => {
      redis.seedSession('u1', 'sid-1', session('u1', 1000));
      await tracker.untrack('u1', 'sid-1');
      expect(redis.members('u1')).toEqual([]);

      redis.failSrem = new Error('connection lost');
      await expect(tracker.untrack('u1', 'sid-2')).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns live members and prunes missing, foreign-user, unparseable and past-cap members in ONE SREM', async () => {
      redis.seedSession('u1', 'live', session('u1', 60_000));
      redis.seedSession('u1', 'foreign', session('u-other', 60_000));
      redis.seedSession(
        'u1',
        'pastCap',
        session('u1', SESSION_ABSOLUTE_MAX_AGE_MS + 1),
      );
      redis.seedSession('u1', 'garbage', 'not json{');
      redis.seedSession('u1', 'noCreatedAt', {
        cookie: {},
        systemUserId: 'u1',
      });
      // 'missing' is in the index but has no key.
      redis.sets.get(sessionIndexKey('u1'))!.add('missing');

      const sessions = await tracker.list('u1');

      expect(sessions.map((s) => s.sid)).toEqual(['live']);
      const sremCalls = redis.log.filter((c) => c[0] === 'srem');
      expect(sremCalls).toHaveLength(1);
      expect((sremCalls[0].slice(2) as string[]).sort()).toEqual(
        ['foreign', 'garbage', 'missing', 'noCreatedAt', 'pastCap'].sort(),
      );
      expect(redis.members('u1')).toEqual(['live']);
    });

    it('does not SREM at all when every member is live', async () => {
      redis.seedSession('u1', 'a', session('u1', 1000));
      await tracker.list('u1');
      expect(redis.log.some((c) => c[0] === 'srem')).toBe(false);
    });

    it('reports ip and userAgent from the session JSON, and null when absent (a pre-deploy session)', async () => {
      redis.seedSession('u1', 'a', session('u1', 1000));
      redis.seedSession('u1', 'b', {
        cookie: {},
        systemUserId: 'u1',
        createdAt: NOW - 1000,
      });
      const byId = Object.fromEntries(
        (await tracker.list('u1')).map((s) => [s.sid, s]),
      );
      expect(byId.a.ip).toBe('203.0.113.7');
      expect(byId.a.userAgent).toContain('Firefox');
      expect(byId.b.ip).toBeNull();
      expect(byId.b.userAgent).toBeNull();
    });

    it('serves the response when only the prune fails (warn, not 503)', async () => {
      redis.seedSession('u1', 'live', session('u1', 1000));
      redis.seedSession('u1', 'foreign', session('u-other', 1000));
      redis.failSrem = new Error('READONLY');
      await expect(tracker.list('u1')).resolves.toHaveLength(1);
    });

    it('maps a failed read to a 503 with the standard message', async () => {
      redis.failSmembers = new Error('connection lost');
      await expect(tracker.list('u1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(tracker.list('u1')).rejects.toMatchObject({
        response: { message: 'Session store unavailable.' },
      });
    });

    it('maps a failed read pipeline to a 503', async () => {
      redis.seedSession('u1', 'a', session('u1', 1000));
      redis.failExec = new Error('connection lost');
      await expect(tracker.list('u1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    describe('lastActiveAt = clamp(now - (ttl - PTTL), loginAt, now)', () => {
      const lastActive = async (ageMs: number, pttl: number) => {
        const r = new FakeRedis();
        r.seedSession('u1', 's', session('u1', ageMs), pttl);
        const t = new SessionTrackerService(
          r as unknown as Redis,
          {
            getOrThrow: () => SECRET,
            get: () => undefined,
          } as unknown as ConfigService,
        );
        const [s] = await t.list('u1');
        return { s, loginAt: NOW - ageMs };
      };

      it('is now − (idleTtl − pttl)', async () => {
        // 5 minutes idle: the rolling TTL has ticked down 5 minutes from the full window.
        const { s } = await lastActive(3_600_000, IDLE_MS - 300_000);
        expect(s.lastActiveAt).toBe(NOW - 300_000);
      });

      it('is now for a session touched this instant', async () => {
        const { s } = await lastActive(3_600_000, IDLE_MS);
        expect(s.lastActiveAt).toBe(NOW);
      });

      it('never reports earlier than the login (clamped to loginAt)', async () => {
        // Idle "for 7 h" on a session that logged in 1 h ago is impossible: clamp up to loginAt.
        const { s, loginAt } = await lastActive(
          3_600_000,
          IDLE_MS - 25_200_000,
        );
        expect(s.lastActiveAt).toBe(loginAt);
      });

      it('never reports later than now (a PTTL above the window, e.g. clock skew)', async () => {
        const { s } = await lastActive(3_600_000, IDLE_MS + 60_000);
        expect(s.lastActiveAt).toBe(NOW);
      });

      it('falls back to the login time when the PTTL carries no information', async () => {
        const { s, loginAt } = await lastActive(3_600_000, -1);
        expect(s.lastActiveAt).toBe(loginAt);
      });
    });
  });

  describe('resolveHandle', () => {
    it("finds only the caller's own live session by handle", async () => {
      redis.seedSession('u1', 'mine', session('u1', 1000));
      redis.seedSession('u2', 'theirs', session('u2', 1000));

      const mine = await tracker.resolveHandle('u1', tracker.handleOf('mine'));
      expect(mine?.sid).toBe('mine');

      // Another user's handle is invisible from u1's own Set: same answer as an unknown one.
      await expect(
        tracker.resolveHandle('u1', tracker.handleOf('theirs')),
      ).resolves.toBeNull();
      await expect(
        tracker.resolveHandle('u1', 'A'.repeat(22)),
      ).resolves.toBeNull();
    });

    it('does not resolve a stale member', async () => {
      redis.seedSession('u1', 'gone', session('u1', 1000));
      redis.strings.delete('eb:sess:gone');
      await expect(
        tracker.resolveHandle('u1', tracker.handleOf('gone')),
      ).resolves.toBeNull();
    });
  });

  describe('revokeOne', () => {
    it('DELs the key and SREMs the sid, returning true', async () => {
      redis.seedSession('u1', 'a', session('u1', 1000));
      await expect(tracker.revokeOne('u1', 'a')).resolves.toBe(true);
      expect(redis.strings.has('eb:sess:a')).toBe(false);
      expect(redis.members('u1')).toEqual([]);
    });

    it('returns false when the key already expired (DEL = 0), so the caller answers 404', async () => {
      redis.sets.set(sessionIndexKey('u1'), new Set(['a']));
      await expect(tracker.revokeOne('u1', 'a')).resolves.toBe(false);
      expect(redis.members('u1')).toEqual([]);
    });

    it('maps a Redis failure to a 503', async () => {
      redis.failExec = new Error('connection lost');
      await expect(tracker.revokeOne('u1', 'a')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('revokeAll', () => {
    it('counts only live members whose DEL returned 1, in one MULTI', async () => {
      redis.seedSession('u1', 'a', session('u1', 1000));
      redis.seedSession('u1', 'b', session('u1', 2000));
      // The key vanished (TTL) between the index and the read: not live, so not counted.
      redis.sets.get(sessionIndexKey('u1'))!.add('ghost');

      await expect(tracker.revokeAll('u1')).resolves.toBe(2);

      expect(redis.strings.has('eb:sess:a')).toBe(false);
      expect(redis.strings.has('eb:sess:b')).toBe(false);
      expect(redis.members('u1')).toEqual([]);
      // The write phase is a single MULTI (the read phase used a pipeline).
      expect(redis.multi).toHaveBeenCalledTimes(1);
    });

    it('NEVER DELs a member whose JSON names another user — it only drops it from the index', async () => {
      redis.seedSession('u1', 'mine', session('u1', 1000));
      redis.seedSession('u1', 'foreign', session('u-other', 1000));

      await expect(tracker.revokeAll('u1')).resolves.toBe(1);

      expect(redis.strings.has('eb:sess:foreign')).toBe(true);
      expect(redis.log).not.toContainEqual(['del', 'eb:sess:foreign']);
      expect(redis.members('u1')).toEqual([]);
    });

    it('DELs an own key that is past the cap but does not count it as revoked', async () => {
      redis.seedSession(
        'u1',
        'old',
        session('u1', SESSION_ABSOLUTE_MAX_AGE_MS + 5000),
      );
      redis.seedSession('u1', 'live', session('u1', 1000));

      await expect(tracker.revokeAll('u1')).resolves.toBe(1);
      expect(redis.strings.has('eb:sess:old')).toBe(false);
    });

    it('spares `except` entirely: neither DEL nor SREM', async () => {
      redis.seedSession('u1', 'current', session('u1', 1000));
      redis.seedSession('u1', 'other', session('u1', 2000));

      await expect(
        tracker.revokeAll('u1', { except: 'current' }),
      ).resolves.toBe(1);

      expect(redis.strings.has('eb:sess:current')).toBe(true);
      expect(redis.members('u1')).toEqual(['current']);
    });

    it('returns 0 and issues no write when there is nothing to revoke (idempotent)', async () => {
      await expect(tracker.revokeAll('u1')).resolves.toBe(0);
      expect(redis.multi).not.toHaveBeenCalled();

      redis.seedSession('u1', 'current', session('u1', 1000));
      await expect(
        tracker.revokeAll('u1', { except: 'current' }),
      ).resolves.toBe(0);
      expect(redis.multi).not.toHaveBeenCalled();
    });

    it('does not remove a member that logged in after the read (R-13: it SREMs only what it read)', async () => {
      redis.seedSession('u1', 'a', session('u1', 1000));
      const originalExec = redis.multi.getMockImplementation()!;
      // A concurrent login lands between the read phase and the write phase.
      redis.multi.mockImplementationOnce(() => {
        redis.seedSession('u1', 'late', session('u1', 10));
        return originalExec();
      });

      await expect(tracker.revokeAll('u1')).resolves.toBe(1);
      expect(redis.members('u1')).toEqual(['late']);
      expect(redis.strings.has('eb:sess:late')).toBe(true);
    });

    it('maps a failed read or a failed EXEC to a 503 and reports nothing revoked', async () => {
      redis.seedSession('u1', 'a', session('u1', 1000));
      redis.failSmembers = new Error('connection lost');
      await expect(tracker.revokeAll('u1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      redis.failSmembers = null;
      redis.multi.mockImplementationOnce(() => {
        throw new Error('connection lost');
      });
      await expect(tracker.revokeAll('u1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(redis.strings.has('eb:sess:a')).toBe(true);
    });
  });

  it('never logs a sid or a handle', async () => {
    const errorSpy = jest.spyOn(
      (tracker as unknown as { logger: { error: () => void } }).logger,
      'error',
    );
    const warnSpy = jest.spyOn(
      (tracker as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    );
    redis.failExec = new Error('connection lost');
    await tracker.track('u1', 'SECRET-SID');
    await tracker.revokeOne('u1', 'SECRET-SID').catch(() => undefined);

    const logged = JSON.stringify([
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]);
    expect(logged).not.toContain('SECRET-SID');
    expect(logged).not.toContain(tracker.handleOf('SECRET-SID'));
  });
});
