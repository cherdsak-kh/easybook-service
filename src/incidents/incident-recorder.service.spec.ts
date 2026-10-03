import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { LineCallError } from '../line/line-call-error';
import { IncidentRecorder } from './incident-recorder.service';
import type { IncidentStore } from './incident-store';
import {
  INCIDENT_FIFO,
  SIGNATURE_LIMIT,
  SIGNATURE_WINDOW_MS,
} from './incidents.constants';
import {
  IncidentComponent,
  IncidentSeverity,
  type IncidentDraftRecord,
  type RequestLike,
  type TraceContext,
} from './incident.types';
import { traceStorage } from './trace-context';

class FakeRedis extends EventEmitter {
  status = 'ready';
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(opts: { addImpl?: () => Promise<string> } = {}) {
  const redis = new FakeRedis();
  const added: IncidentDraftRecord[] = [];
  const store = {
    add: jest.fn((rec: IncidentDraftRecord) => {
      if (opts.addImpl) return opts.addImpl();
      added.push(rec);
      return Promise.resolve(`ERR-${rec.status ?? 'SYS'}-${added.length}`);
    }),
  };
  const recorder = new IncidentRecorder(
    redis as unknown as Redis,
    store as unknown as IncidentStore,
  );
  return { redis, store, added, recorder };
}

const req = (over: Partial<RequestLike> = {}): RequestLike => ({
  method: 'GET',
  path: '/api/v1/x',
  route: { path: '/api/v1/x' },
  ...over,
});

const ctxOf = (over: Partial<TraceContext> = {}): TraceContext => ({
  traceId: 'tr-0123456789abcdef',
  startedAt: Date.now(),
  method: 'GET',
  req: req(),
  drafts: [],
  closed: false,
  ...over,
});

describe('IncidentRecorder', () => {
  let recorder: IncidentRecorder;
  afterEach(() => {
    recorder?.onModuleDestroy();
    jest.restoreAllMocks();
  });

  describe('settle', () => {
    it('records a 5xx exception as ONE incident stamped with the request', async () => {
      const s = setup();
      recorder = s.recorder;
      const ctx = ctxOf({ error: new Error('kaboom') });
      recorder.settle(ctx, 500);
      await flush();
      expect(s.added).toHaveLength(1);
      expect(s.added[0]).toMatchObject({
        traceId: 'tr-0123456789abcdef',
        status: 500,
        method: 'GET',
        routeTemplate: '/api/v1/x',
        component: IncidentComponent.API,
        severity: IncidentSeverity.ERROR,
        message: 'kaboom',
      });
    });

    it.each([400, 401, 403, 404, 409, 422, 429])(
      'records NOTHING for a %i, even with the exception remembered (D-19c)',
      async (status) => {
        const s = setup();
        recorder = s.recorder;
        recorder.settle(ctxOf({ error: new Error('user mistake') }), status);
        await flush();
        expect(s.store.add).not.toHaveBeenCalled();
      },
    );

    it('records a 5xx with no exception (an Express-middleware 5xx) as API or Redis', async () => {
      const s = setup();
      recorder = s.recorder;
      recorder.settle(ctxOf(), 503);
      s.redis.status = 'reconnecting';
      recorder.settle(ctxOf({ traceId: 'tr-bbbbbbbbbbbbbbbb' }), 503);
      await flush();
      expect(s.added).toHaveLength(1); // the second went to the outage buffer
      expect(s.added[0].component).toBe(IncidentComponent.API);
      expect(s.added[0].message).toBe(
        'HTTP 503 raised before the route handler',
      );
      expect(recorder.bufferedCount).toBe(1);
    });

    it('collapses a 5xx and its external drafts into one incident (the more severe wins, ties go to the draft)', async () => {
      const s = setup();
      recorder = s.recorder;
      const ctx = ctxOf({ error: new Error('Image storage is unavailable.') });
      ctx.drafts.push({
        severity: IncidentSeverity.ERROR,
        component: IncidentComponent.CLOUDFLARE_R2,
        atMs: Date.now(),
        error: new Error('s3 denied'),
        operation: 'putImage',
      });
      recorder.settle(ctx, 502);
      await flush();
      expect(s.added).toHaveLength(1);
      expect(s.added[0].component).toBe(IncidentComponent.CLOUDFLARE_R2);
      expect(s.added[0].status).toBe(502);
    });

    it('turns each draft of a 2xx request into its own incident with the request status', async () => {
      const s = setup();
      recorder = s.recorder;
      const ctx = ctxOf();
      for (const operation of ['reply', 'push']) {
        ctx.drafts.push({
          severity: IncidentSeverity.WARNING,
          component: IncidentComponent.LINE_OA,
          atMs: Date.now(),
          operation,
          message: `${operation} took 4000 ms (budget 3000 ms)`,
        });
      }
      recorder.settle(ctx, 200);
      await flush();
      expect(s.added.map((r) => [r.status, r.severity])).toEqual([
        [200, IncidentSeverity.WARNING],
        [200, IncidentSeverity.WARNING],
      ]);
    });

    it('settles once: a second call (finish then close) is a no-op', async () => {
      const s = setup();
      recorder = s.recorder;
      const ctx = ctxOf({ error: new Error('x') });
      recorder.settle(ctx, 500);
      recorder.settle(ctx, 500);
      await flush();
      expect(s.added).toHaveLength(1);
      expect(ctx.closed).toBe(true);
    });

    it('never throws into the caller, even with a corrupt context', () => {
      const s = setup();
      recorder = s.recorder;
      const broken = {
        closed: false,
        get drafts(): never {
          throw new Error('x');
        },
      } as unknown as TraceContext;
      expect(() => recorder.settle(broken, 500)).not.toThrow();
    });
  });

  describe('external', () => {
    it('joins the live request drafts inside a trace context', async () => {
      const s = setup();
      recorder = s.recorder;
      const ctx = ctxOf();
      traceStorage.run(ctx, () => {
        recorder.external({
          component: IncidentComponent.LINE_OA,
          operation: 'push',
          error: new Error('LINE down'),
        });
      });
      await flush();
      expect(ctx.drafts).toHaveLength(1);
      expect(s.store.add).not.toHaveBeenCalled();
    });

    it('records at once with a system caller and a fresh trace id outside a request', async () => {
      const s = setup();
      recorder = s.recorder;
      recorder.external({
        component: IncidentComponent.LINE_OA,
        operation: 'push',
        error: new Error('LINE down in a cron'),
      });
      await flush();
      expect(s.added).toHaveLength(1);
      expect(s.added[0]).toMatchObject({
        status: null,
        method: null,
        routeTemplate: null,
        component: IncidentComponent.LINE_OA,
        severity: IncidentSeverity.ERROR,
      });
      expect(s.added[0].caller.label).toBe('system (LINE OA push)');
      expect(s.added[0].traceId).toMatch(/^tr-[0-9a-f]{16}$/);
    });

    it('records a call that outlived the request (the context is already closed)', async () => {
      const s = setup();
      recorder = s.recorder;
      const ctx = ctxOf({ closed: true });
      traceStorage.run(ctx, () => {
        recorder.external({
          component: IncidentComponent.REDIS,
          operation: 'del',
          error: new Error('late'),
        });
      });
      await flush();
      expect(s.added).toHaveLength(1);
      expect(ctx.drafts).toHaveLength(0);
    });

    it('ignores an unconfigured LINE client (a config state, not an incident)', async () => {
      const s = setup();
      recorder = s.recorder;
      recorder.external({
        component: IncidentComponent.LINE_OA,
        operation: 'push',
        error: new LineCallError('NOT_CONFIGURED', null),
      });
      await flush();
      expect(s.store.add).not.toHaveBeenCalled();
    });
  });

  describe('track', () => {
    it('returns the value untouched and records nothing for a fast success', async () => {
      const s = setup();
      recorder = s.recorder;
      const value = { ok: true };
      await expect(
        recorder.track(IncidentComponent.LINE_OA, 'push', 3000, () =>
          Promise.resolve(value),
        ),
      ).resolves.toBe(value);
      await flush();
      expect(s.store.add).not.toHaveBeenCalled();
    });

    it('rethrows the IDENTICAL error object and records the failure', async () => {
      const s = setup();
      recorder = s.recorder;
      const boom = new Error('LINE down');
      await expect(
        recorder.track(IncidentComponent.LINE_OA, 'push', 3000, () =>
          Promise.reject(boom),
        ),
      ).rejects.toBe(boom);
      await flush();
      expect(s.added).toHaveLength(1);
      expect(s.added[0].severity).toBe(IncidentSeverity.ERROR);
    });

    it('records a WARNING for a delivered call over its latency budget', async () => {
      const s = setup();
      recorder = s.recorder;
      const realNow = Date.now;
      let calls = 0;
      jest
        .spyOn(Date, 'now')
        .mockImplementation(() => realNow() + (calls++ > 0 ? 4000 : 0));
      await recorder.track(IncidentComponent.LINE_OA, 'push', 3000, () =>
        Promise.resolve(1),
      );
      await flush();
      expect(s.added).toHaveLength(1);
      expect(s.added[0].severity).toBe(IncidentSeverity.WARNING);
      expect(s.added[0].context.budgetMs).toBe(3000);
    });
  });

  describe('fail-open and non-recursion', () => {
    it('a throwing store changes nothing for the caller, logs once, and buffers the incident', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const s = setup({
        addImpl: () => Promise.reject(new Error('redis exploded')),
      });
      recorder = s.recorder;
      expect(() => {
        recorder.settle(ctxOf({ error: new Error('a') }), 500);
        recorder.settle(
          ctxOf({ error: new Error('b'), traceId: 'tr-cccccccccccccccc' }),
          500,
        );
      }).not.toThrow();
      await flush();
      expect(warn).toHaveBeenCalledTimes(1); // once per 60 s, not once per incident
      expect(String(warn.mock.calls[0][0])).not.toContain('redis exploded');
      expect(recorder.bufferedCount).toBe(2);
    });

    it('while Redis is not ready the store is NEVER called: the incident goes straight to the buffer', async () => {
      const s = setup();
      recorder = s.recorder;
      s.redis.status = 'reconnecting';
      recorder.settle(ctxOf({ error: new Error('x') }), 500);
      await flush();
      expect(s.store.add).not.toHaveBeenCalled();
      expect(recorder.bufferedCount).toBe(1);
    });

    it('records the Redis outage itself exactly once per outage, without touching the store', async () => {
      const s = setup();
      recorder = s.recorder;
      s.redis.status = 'reconnecting';
      s.redis.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      s.redis.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      s.redis.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      await flush();
      expect(s.store.add).not.toHaveBeenCalled();
      expect(recorder.bufferedCount).toBe(1);
    });

    it('flushes the buffer oldest-first when Redis is ready again, and records a later outage again', async () => {
      const s = setup();
      recorder = s.recorder;
      s.redis.status = 'reconnecting';
      s.redis.emit('error', new Error('connect ECONNREFUSED'));
      recorder.settle(
        ctxOf({
          error: new Error('during outage'),
          traceId: 'tr-dddddddddddddddd',
        }),
        500,
      );
      expect(recorder.bufferedCount).toBe(2);

      s.redis.status = 'ready';
      s.redis.emit('ready');
      await flush();
      await flush();
      expect(s.added.map((r) => r.component)).toEqual([
        IncidentComponent.REDIS, // the outage itself, oldest
        IncidentComponent.API,
      ]);
      expect(recorder.bufferedCount).toBe(0);

      s.redis.status = 'reconnecting';
      s.redis.emit('error', new Error('second outage'));
      expect(recorder.bufferedCount).toBe(1);
    });

    it('a failing flush keeps the remainder', async () => {
      let fail = true;
      const s = setup({
        addImpl: () =>
          fail
            ? Promise.reject(new Error('still down'))
            : Promise.resolve('ERR-SYS-1'),
      });
      recorder = s.recorder;
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      s.redis.status = 'reconnecting';
      recorder.settle(ctxOf({ error: new Error('x') }), 500);
      s.redis.status = 'ready';
      s.redis.emit('ready');
      await flush();
      expect(recorder.bufferedCount).toBe(1);
      fail = false;
      s.redis.emit('ready');
      await flush();
      await flush();
      expect(recorder.bufferedCount).toBe(0);
    });

    it('caps the outage buffer at 200, dropping the oldest', () => {
      const s = setup();
      recorder = s.recorder;
      s.redis.status = 'reconnecting';
      for (let i = 0; i < INCIDENT_FIFO + 30; i += 1) {
        recorder.settle(
          ctxOf({
            error: new Error(`e${i}`),
            traceId: `tr-${String(i).padStart(16, '0')}`,
            req: req({ route: { path: `/api/v1/r${i}` } }),
          }),
          500,
        );
      }
      expect(recorder.bufferedCount).toBe(INCIDENT_FIFO);
    });
  });

  describe('storm control (E-13)', () => {
    it('stores at most 20 per signature per window, then one summary standing for the rest', async () => {
      const s = setup();
      recorder = s.recorder;
      const realNow = Date.now();
      let now = realNow;
      jest.spyOn(Date, 'now').mockImplementation(() => now);

      const fire = () =>
        recorder.settle(
          ctxOf({
            error: new Error('db down'),
            traceId: 'tr-eeeeeeeeeeeeeeee',
          }),
          500,
        );
      for (let i = 0; i < SIGNATURE_LIMIT + 5; i += 1) fire();
      await flush();
      expect(s.added).toHaveLength(SIGNATURE_LIMIT);

      now += SIGNATURE_WINDOW_MS + 1; // next window: the first event rolls the previous one over
      fire();
      await flush();
      expect(s.added).toHaveLength(SIGNATURE_LIMIT + 2);
      const summary = s.added[SIGNATURE_LIMIT];
      expect(summary.context.suppressedCount).toBe(5);
      expect(summary.message).toContain(
        '(+5 similar incidents suppressed in 60 s)',
      );
      expect(summary.message.length).toBeLessThanOrEqual(500);
    });

    it('does not mix signatures', async () => {
      const s = setup();
      recorder = s.recorder;
      for (let i = 0; i < SIGNATURE_LIMIT + 3; i += 1) {
        recorder.settle(
          ctxOf({
            error: new Error('a'),
            req: req({ route: { path: '/api/v1/a' } }),
          }),
          500,
        );
      }
      recorder.settle(
        ctxOf({
          error: new Error('b'),
          req: req({ route: { path: '/api/v1/b' } }),
        }),
        500,
      );
      await flush();
      expect(s.added).toHaveLength(SIGNATURE_LIMIT + 1);
    });
  });
});
