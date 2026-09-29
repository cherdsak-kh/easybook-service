import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { MulterError } from 'multer';
import { from, Observable, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { AdminNotificationTriggers } from './admin-notification-triggers.service';
import { NO_ERROR_NOTIFICATION } from './no-error-notification.decorator';

/**
 * C5's "is this a 5xx" rule (design §2.7), pure and exported so it is unit-tested without booting
 * Nest.
 *
 * - `HttpException` → its status when `>= 500`, else `null` — every 4xx, including the
 *   `PayloadTooLargeException` `MulterErrorTo400Filter` rewrites, is `null`.
 * - `MulterError` → `null` (D-4): Nest/that route filter already maps it to 400, and the plan's rule
 *   ("a non-HttpException") would otherwise have alerted on it as a 500.
 * - Anything else → `500`, exactly what Nest's `BaseExceptionFilter` answers.
 */
export function serverErrorStatus(err: unknown): number | null {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    return status >= 500 ? status : null;
  }
  if (err instanceof MulterError) return null;
  return 500;
}

const CODE_PATTERN = /^[A-Z0-9_]{2,12}$/i;
const NAME_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

/**
 * C5's error-code whitelist (design §2.7) — no free text can escape into a notification body. The
 * first match wins.
 */
export function serverErrorCode(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string' &&
    CODE_PATTERN.test((err as { code: string }).code)
  ) {
    return (err as { code: string }).code;
  }
  if (err instanceof HttpException) return `HTTP_${err.getStatus()}`;
  if (err instanceof Error && NAME_PATTERN.test(err.name)) return err.name;
  return 'Error';
}

/**
 * C5 — a global `APP_INTERCEPTOR` (registered by `NotificationsModule`) that fires
 * `AdminNotificationTriggers.serverError` on an unhandled 5xx, then RETHROWS THE IDENTICAL ERROR
 * OBJECT unchanged (design §2.7, R-3).
 *
 * 🔴 NOT A FILTER. An interceptor never touches the response — no `map`, no header write, no `res`
 * access — so the success path and the eventual filter-produced error body stay byte-identical to
 * HEAD (AC-9). `MulterErrorTo400Filter` and `BaseExceptionFilter` see the exact same reference this
 * interceptor was handed.
 *
 * HTTP only (`ctx.getType() === 'http'`): WebSocket and cron contexts are out (R-3), because a bare
 * `ExecutionContext` has no HTTP request to read a route template from.
 */
@Injectable()
export class ServerErrorNotificationInterceptor implements NestInterceptor {
  constructor(
    private readonly triggers: AdminNotificationTriggers,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      ctx.getType() !== 'http' ||
      !this.triggers.isEnabled ||
      this.reflector.getAllAndOverride<boolean>(NO_ERROR_NOTIFICATION, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    ) {
      return next.handle();
    }

    return next.handle().pipe(
      catchError((err: unknown) => {
        const status = serverErrorStatus(err);
        if (status === null) return throwError(() => err);

        const req = ctx.switchToHttp().getRequest<Request>();
        const routeTemplate =
          typeof (req as { route?: { path?: unknown } }).route?.path ===
          'string'
            ? ((req as { route?: { path?: string } }).route!.path as string)
            : null;
        const payload = {
          status,
          errorCode: serverErrorCode(err),
          handler: `${ctx.getClass().name}.${ctx.getHandler().name}`,
          method: req.method,
          routeTemplate,
        };

        // Belt and braces over the never-reject contract: `serverError` already never rejects, but
        // the interceptor must not care if that contract is ever broken.
        return from(
          this.triggers.serverError(payload).catch(() => undefined),
        ).pipe(mergeMap(() => throwError(() => err)));
      }),
    );
  }
}
