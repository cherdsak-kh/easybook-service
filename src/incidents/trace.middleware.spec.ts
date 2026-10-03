import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { IncidentRecorder } from './incident-recorder.service';
import { TRACE_CTX } from './incidents.constants';
import type { TraceContext } from './incident.types';
import type { RequestMetrics } from './request-metrics';
import { currentTrace } from './trace-context';
import {
  createTraceMiddleware,
  isCountedRequest,
  resolveTraceId,
} from './trace.middleware';

class FakeRes extends EventEmitter {
  statusCode = 200;
  locals: Record<string, unknown> = {};
  headers: Record<string, string> = {};
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
}

function run(inbound?: string, method = 'GET', path = '/api/v1/x') {
  const recorder = { settle: jest.fn<void, [TraceContext, number]>() };
  const metrics = { count: jest.fn<void, [Date, boolean]>() };
  const mw = createTraceMiddleware(
    recorder as unknown as IncidentRecorder,
    metrics as unknown as RequestMetrics,
  );
  const res = new FakeRes();
  const req = {
    headers: inbound === undefined ? {} : { 'x-request-id': inbound },
    method,
    path,
  };
  let seenInside: TraceContext | undefined;
  const next = jest.fn(() => {
    seenInside = currentTrace();
  });
  mw(req as unknown as Request, res as unknown as Response, next);
  return { recorder, metrics, res, next, seenInside: () => seenInside };
}

describe('trace.middleware', () => {
  describe('resolveTraceId (D-18)', () => {
    it('echoes a valid inbound id', () => {
      expect(resolveTraceId('abcd1234-ef56')).toBe('abcd1234-ef56');
      expect(resolveTraceId('a'.repeat(64))).toBe('a'.repeat(64));
    });

    it.each([
      ['a newline', 'abcd1234\nX-Injected: 1'],
      ['65 characters', 'a'.repeat(65)],
      ['7 characters', 'abcd123'],
      ['an angle bracket', 'abcd1234<script>'],
      ['a space', 'abcd 1234efgh'],
      ['an underscore', 'abcd_1234efgh'],
      ['non-string', 12345678],
      ['undefined', undefined],
    ])('replaces an id with %s', (_label, inbound) => {
      const id = resolveTraceId(inbound);
      expect(id).toMatch(/^tr-[0-9a-f]{16}$/);
    });

    it('mints a different id each time', () => {
      expect(resolveTraceId(undefined)).not.toBe(resolveTraceId(undefined));
    });
  });

  describe('createTraceMiddleware', () => {
    it('sets X-Request-Id, stores the context on res.locals and runs next inside the trace context', () => {
      const { res, next, seenInside } = run('abcd1234-ef56');
      expect(res.headers['X-Request-Id']).toBe('abcd1234-ef56');
      expect((res.locals[TRACE_CTX] as TraceContext).traceId).toBe(
        'abcd1234-ef56',
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(seenInside()?.traceId).toBe('abcd1234-ef56');
    });

    it('replaces an invalid inbound id before it reaches the header', () => {
      const { res } = run('bad id\r\nSet-Cookie: x=1');
      expect(res.headers['X-Request-Id']).toMatch(/^tr-[0-9a-f]{16}$/);
      expect(res.headers['X-Request-Id']).not.toContain('\n');
    });

    it('settles exactly once when both finish and close fire, and counts the request', () => {
      const { res, recorder, metrics } = run('abcd1234-ef56');
      res.statusCode = 502;
      res.emit('finish');
      res.emit('close');
      expect(recorder.settle).toHaveBeenCalledTimes(1);
      expect(recorder.settle.mock.calls[0][1]).toBe(502);
      expect(metrics.count).toHaveBeenCalledTimes(1);
      expect(metrics.count.mock.calls[0][1]).toBe(true);
    });

    it('does not count an OPTIONS preflight, the health probe or a non-API path', () => {
      for (const [method, path] of [
        ['OPTIONS', '/api/v1/reports/overview'],
        ['GET', '/api/v1/health'],
        ['GET', '/'],
        ['GET', '/docs-json'],
      ]) {
        const { res, metrics } = run(undefined, method, path);
        res.emit('finish');
        expect(metrics.count).not.toHaveBeenCalled();
      }
    });

    it('counts a 200 as not-5xx', () => {
      const { res, metrics } = run();
      res.emit('finish');
      expect(metrics.count.mock.calls[0][1]).toBe(false);
    });

    it('never throws from a listener, even when the recorder throws', () => {
      const { res, recorder } = run();
      recorder.settle.mockImplementation(() => {
        throw new Error('recorder bug');
      });
      expect(() => res.emit('finish')).not.toThrow();
    });
  });

  describe('isCountedRequest', () => {
    it('counts API calls only', () => {
      expect(isCountedRequest('GET', '/api/v1/reports/overview')).toBe(true);
      expect(isCountedRequest('POST', '/api/v1/auth/system/login')).toBe(true);
      expect(isCountedRequest('OPTIONS', '/api/v1/x')).toBe(false);
      expect(isCountedRequest('GET', '/api/v1/health')).toBe(false);
      expect(isCountedRequest('GET', '/api/v1/healthz')).toBe(false);
      expect(isCountedRequest('GET', '/')).toBe(false);
    });
  });
});
