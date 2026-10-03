import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { API_BASE_PATH } from '../common/api.constants';
import type { IncidentRecorder } from './incident-recorder.service';
import {
  REQUEST_ID_HEADER,
  TRACE_CTX,
  TRACE_ID_PATTERN,
} from './incidents.constants';
import type { TraceContext } from './incident.types';
import type { RequestMetrics } from './request-metrics';
import { traceStorage } from './trace-context';

/** A reusable inbound id, or a fresh `tr-<16 hex>`. A newline, `<`, 65+ chars or a short value is replaced. */
export function resolveTraceId(inbound: unknown): string {
  if (typeof inbound === 'string' && TRACE_ID_PATTERN.test(inbound)) {
    return inbound;
  }
  return `tr-${randomBytes(8).toString('hex')}`;
}

const API_PREFIX = `${API_BASE_PATH}/`;
const HEALTH_PREFIX = `${API_BASE_PATH}/health`;

/** Counted for the availability KPI: API calls, minus OPTIONS preflights and the liveness probe. */
export function isCountedRequest(method: string, path: string): boolean {
  return (
    method !== 'OPTIONS' &&
    path.startsWith(API_PREFIX) &&
    !path.startsWith(HEALTH_PREFIX)
  );
}

/**
 * Step 0 of `configureApp`, BEFORE CORS (design §2.5.1): even preflights, session 503s and CSRF 403s
 * carry `X-Request-Id`, and the trace context exists before every guard.
 *
 * It only (a) sets one response header, (b) stores a context object, (c) attaches `finish`/`close`
 * listeners. It never writes, ends, delays or reads the response or the request body, so `rawBody`,
 * the LINE HMAC and every status and body stay byte-identical.
 */
export function createTraceMiddleware(
  recorder: IncidentRecorder,
  metrics: RequestMetrics,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    let ctx: TraceContext;
    try {
      ctx = {
        traceId: resolveTraceId(req.headers['x-request-id']),
        startedAt: Date.now(),
        method: req.method,
        req,
        drafts: [],
        closed: false,
      };
      res.setHeader(REQUEST_ID_HEADER, ctx.traceId);
      res.locals[TRACE_CTX] = ctx;
    } catch {
      next();
      return;
    }

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      try {
        const status = res.statusCode;
        recorder.settle(ctx, status);
        if (isCountedRequest(req.method, req.path)) {
          metrics.count(new Date(), status >= 500);
        }
      } catch {
        // Never reaches the already-finished response.
      }
    };
    res.once('finish', settle);
    res.once('close', settle);

    traceStorage.run(ctx, next);
  };
}
