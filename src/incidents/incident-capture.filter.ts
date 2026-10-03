import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { TRACE_CTX } from './incidents.constants';
import type { TraceContext } from './incident.types';

/**
 * Remembers the exception on the request's trace context, then does EXACTLY what Nest does without a
 * global filter (design §2.5.1, §2.5.5): `BaseExceptionFilter.catch(exception, host)` with the same
 * arguments. The status and body therefore come from the identical code path, so no response changes.
 *
 * - Method-scoped filters (`MulterErrorTo400Filter`) still win on their three routes: Nest checks
 *   method, then class, then global.
 * - Gateways never see global filters, so no WebSocket path is affected.
 * - The remembered exception is only READ later, on `finish`, by `IncidentRecorder.settle`. A 4xx is
 *   remembered too but never recorded (D-19c).
 */
@Catch()
export class IncidentCaptureFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    try {
      if (host.getType() === 'http') {
        const res = host.switchToHttp().getResponse<Response>();
        const ctx = res.locals?.[TRACE_CTX] as TraceContext | undefined;
        if (ctx) ctx.error = exception;
      }
    } catch {
      // Capture is best-effort; the response below must not depend on it.
    }
    super.catch(exception, host);
  }
}
