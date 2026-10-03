import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HTTPFetchError } from '@line/bot-sdk';
import { isWriteConflict } from '../common/prisma-tx.util';
import { LINE_VERIFICATION_UNAVAILABLE } from '../line/guards/line-id-token.guard';
import { classifyLineError, LineCallError } from '../line/line-call-error';
import { IMAGE_UPLOAD_FAILED } from '../storage/storage.errors';
import {
  IncidentComponent,
  IncidentSeverity,
  type ExternalOutcome,
} from './incident.types';

/**
 * Pure classification (design §2.5.2, D-19). No Nest, no I/O. `incident-classify.spec.ts` pins every
 * row of the table; the row numbers below are that table's.
 */

/** Bound on the cause-chain walk — errors can be cyclic, and the real chain is ~3 deep. */
const CHAIN_MAX_NODES = 16;

const DB_UNREACHABLE_PRISMA_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
]);
const DB_UNREACHABLE_CAUSE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  '57P01',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08006',
]);

function chainOf(e: unknown): object[] {
  const seen = new Set<object>();
  const queue: unknown[] = [e];
  const out: object[] = [];
  while (queue.length > 0 && seen.size < CHAIN_MAX_NODES) {
    const cur = queue.shift();
    if (cur === null || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    const node = cur as { cause?: unknown; meta?: unknown };
    queue.push(node.cause);
    if (node.meta !== null && typeof node.meta === 'object') {
      const meta = node.meta as {
        cause?: unknown;
        driverAdapterError?: unknown;
      };
      queue.push(meta.cause, meta.driverAdapterError);
    }
  }
  return out;
}

/** Row 2. */
export function isDbUnreachable(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientInitializationError) return true;
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    DB_UNREACHABLE_PRISMA_CODES.has(e.code)
  ) {
    return true;
  }
  return chainOf(e).some((node) => {
    const n = node as { code?: unknown; originalCode?: unknown };
    const code = typeof n.originalCode === 'string' ? n.originalCode : n.code;
    return typeof code === 'string' && DB_UNREACHABLE_CAUSE_CODES.has(code);
  });
}

function isPrismaError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return (
    e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientUnknownRequestError ||
    e instanceof Prisma.PrismaClientValidationError ||
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientRustPanicError ||
    name === 'DriverAdapterError'
  );
}

const REDIS_ERROR_NAMES = new Set([
  'ReplyError',
  'MaxRetriesPerRequestError',
  'AbortError',
]);
const REDIS_MESSAGE =
  /Connection is closed|Stream isn't writeable|enableOfflineQueue/;

function isRedisError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return REDIS_ERROR_NAMES.has(e.name) || REDIS_MESSAGE.test(e.message);
}

function isLineError(e: unknown): boolean {
  return (
    e instanceof LineCallError ||
    e instanceof HTTPFetchError ||
    (e instanceof HttpException && e.message === LINE_VERIFICATION_UNAVAILABLE)
  );
}

function isR2Error(e: unknown): boolean {
  if (e instanceof HttpException) return e.message === IMAGE_UPLOAD_FAILED;
  if (typeof e !== 'object' || e === null) return false;
  const n = e as { $metadata?: unknown; name?: unknown };
  return n.$metadata !== undefined || n.name === 'S3ServiceException';
}

export interface HttpClassification {
  severity: IncidentSeverity;
  component: IncidentComponent;
}

const E = IncidentSeverity.ERROR;
const C = IncidentSeverity.CRITICAL;

/** Rows 1-9: an HTTP 5xx. `routeTemplate` is the Express route path (or null). */
export function classifyHttp(
  error: unknown,
  routeTemplate: string | null,
  redisReady: boolean,
): HttpClassification {
  if (error === undefined) {
    // Row 9: an Express-middleware 5xx has no exception (e.g. the session store 503).
    return {
      severity: E,
      component: redisReady ? IncidentComponent.API : IncidentComponent.REDIS,
    };
  }
  if (isWriteConflict(error)) {
    return { severity: C, component: IncidentComponent.PRISMA_DB };
  }
  if (isDbUnreachable(error)) {
    return { severity: C, component: IncidentComponent.PRISMA_DB };
  }
  if (isPrismaError(error)) {
    return { severity: E, component: IncidentComponent.PRISMA_DB };
  }
  if (isRedisError(error)) {
    return { severity: E, component: IncidentComponent.REDIS };
  }
  if (isLineError(error)) {
    return { severity: E, component: IncidentComponent.LINE_OA };
  }
  if (isR2Error(error)) {
    return { severity: E, component: IncidentComponent.CLOUDFLARE_R2 };
  }
  if (routeTemplate?.startsWith('/api/v1/auth/')) {
    return { severity: E, component: IncidentComponent.AUTH };
  }
  return { severity: E, component: IncidentComponent.API };
}

/**
 * Rows 10-15: an external-call outcome. `null` = not an incident (an unconfigured client is a
 * configuration state that การเชื่อมต่อระบบ already shows; a 409 on a retry key is a success).
 */
export function classifyExternal(outcome: ExternalOutcome): {
  severity: IncidentSeverity;
  lineErrorKind?: string;
  status?: number;
} | null {
  if (outcome.error === undefined) {
    // Row 15: succeeded after >= 1 retry, or over its latency budget.
    const retried = (outcome.attempts ?? 1) > 1;
    const slow =
      outcome.latencyMs !== undefined &&
      outcome.budgetMs !== undefined &&
      outcome.latencyMs > outcome.budgetMs;
    return retried || slow ? { severity: IncidentSeverity.WARNING } : null;
  }

  if (outcome.component === IncidentComponent.LINE_OA) {
    const line = classifyLineError(outcome.error);
    const status = line.status ?? undefined;
    if (line.kind === 'ALREADY_ACCEPTED') return null;
    if (line.kind === 'NOT_CONFIGURED') {
      // Row 12 vs row 10: no client at all is a config state; a 401/403 from LINE is a real failure.
      return line.status === 401 || line.status === 403
        ? { severity: E, lineErrorKind: line.kind, status }
        : null;
    }
    if (line.kind === 'REJECTED') {
      return {
        severity: IncidentSeverity.WARNING,
        lineErrorKind: line.kind,
        status,
      };
    }
    return { severity: E, lineErrorKind: line.kind, status };
  }
  return { severity: E };
}

const CODE_PATTERN = /^[A-Z0-9_]{2,12}$/i;
const NAME_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

/**
 * A short, whitelisted error code (no free text). Mirrors C5's `serverErrorCode` on purpose rather than
 * importing it: that file pulls in `AdminNotificationTriggers` -> `RedisService`, which now depends on
 * the recorder, and a file cycle there would be a boot-order bug.
 */
export function errorCodeOf(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
  if (err instanceof LineCallError) return err.kind;
  if (typeof err === 'object' && err !== null) {
    const n = err as { code?: unknown; name?: unknown; $metadata?: unknown };
    if (n.$metadata !== undefined && typeof n.name === 'string') {
      return NAME_PATTERN.test(n.name) ? n.name.slice(0, 40) : 'Error';
    }
    if (typeof n.code === 'string' && CODE_PATTERN.test(n.code)) return n.code;
  }
  if (err instanceof HttpException) return `HTTP_${err.getStatus()}`;
  if (err instanceof Error && NAME_PATTERN.test(err.name)) return err.name;
  return 'Error';
}
