import { Prisma } from '@prisma/client';
import {
  MESSAGE_MAX,
  PARAM_MAX,
  STACK_MAX_BYTES,
  STACK_MAX_LINES,
  UA_MAX,
} from './incidents.constants';
import {
  IncidentCallerKind,
  IncidentComponent,
  type IncidentCaller,
  type IncidentContext,
  type IncidentDraft,
  type IncidentDraftRecord,
  type RequestLike,
} from './incident.types';

/**
 * THE only path into the incident store (design §2.5.3, D-21). A WHITELIST: a record is assembled
 * field by field from named sources, so a request body, cookie, `Authorization`, `x-line-signature`,
 * `replyToken`, CSRF/session token or env value cannot reach it. They are never read. `scrub` is the
 * second net, for the free text that is read (an error message, a path parameter, a user agent).
 */

export const COMPONENT_LABEL: Record<IncidentComponent, string> = {
  [IncidentComponent.LINE_OA]: 'LINE OA',
  [IncidentComponent.PRISMA_DB]: 'Prisma / DB',
  [IncidentComponent.CLOUDFLARE_R2]: 'Cloudflare R2',
  [IncidentComponent.REDIS]: 'Redis',
  [IncidentComponent.AUTH]: 'Auth',
  [IncidentComponent.API]: 'API',
};

/** `U4af49…c2e1`: the first 5 hex digits and the last 4 of a LINE user id. */
export function maskLineId(id: string): string {
  return `U${id.slice(1, 6)}…${id.slice(-4)}`;
}

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const LINE_ID = /U[0-9a-f]{32}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TH_PHONE = /(?:\+66|0)\s?\d(?:[\s-]?\d){7,8}/g;
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

/**
 * Replaces, in order: JWT-like tokens, full LINE user ids, e-mails, Thai phone numbers and (message
 * text only) any run of 32+ token-ish characters: channel secrets, access tokens, reply tokens, R2
 * keys. Stack FRAME lines skip the last rule so file paths survive.
 */
export function scrub(text: string, opts: { frame?: boolean } = {}): string {
  let s = text
    .replace(JWT, '[token]')
    .replace(LINE_ID, (m) => maskLineId(m))
    .replace(EMAIL, '[email]')
    .replace(TH_PHONE, '[phone]');
  if (!opts.frame) s = s.replace(LONG_RUN, '[redacted]');
  return s;
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1].trim() : '';
}

function isPrismaClientError(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientUnknownRequestError ||
    e instanceof Prisma.PrismaClientValidationError ||
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientRustPanicError
  );
}

/** The class-aware message BEFORE scrubbing/truncation. Prisma's invocation excerpts echo arguments, so they are dropped. */
function rawMessageOf(error: unknown): string {
  if (error instanceof Prisma.PrismaClientValidationError) {
    return 'Invalid Prisma query (arguments withheld)';
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.code}: ${lastNonEmptyLine(error.message)}`;
  }
  if (isPrismaClientError(error)) {
    return lastNonEmptyLine((error as Error).message);
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export function messageOf(error: unknown): string {
  return scrub(rawMessageOf(error)).slice(0, MESSAGE_MAX);
}

const CAUSE_BLOCKS_MAX = 2;

/**
 * `<name>: <message>` then ONLY the `    at ...` frames, then up to two `Caused by:` blocks. Prisma's
 * multi-line invocation excerpt (which can echo argument values) sits between the headline and the
 * frames, and is dropped by construction. Capped at 50 lines and 8 KB.
 */
export function stackOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const lines: string[] = [`${error.name}: ${messageOf(error)}`];
  for (const line of (error.stack ?? '').split(/\r?\n/)) {
    if (/^\s+at /.test(line)) lines.push(scrub(line, { frame: true }));
  }
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let i = 0; i < CAUSE_BLOCKS_MAX && cause !== undefined; i += 1) {
    const name = cause instanceof Error ? cause.name : 'Error';
    lines.push(`Caused by: ${name}: ${messageOf(cause)}`);
    cause =
      typeof cause === 'object' && cause !== null
        ? (cause as { cause?: unknown }).cause
        : undefined;
  }
  let out = lines.slice(0, STACK_MAX_LINES).join('\n');
  while (Buffer.byteLength(out, 'utf8') > STACK_MAX_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return out;
}

export function callerOf(
  req: RequestLike | null,
  component: IncidentComponent,
  operation: string | undefined,
): IncidentCaller {
  if (!req) {
    return {
      kind: IncidentCallerKind.SYSTEM,
      label: `system (${COMPONENT_LABEL[component]}${operation ? ` ${operation}` : ''})`,
    };
  }
  const staff = req.systemUser;
  if (staff && typeof staff.id === 'string') {
    return {
      kind: IncidentCallerKind.STAFF,
      label: `staff:${staff.id} (${staff.role ?? 'UNKNOWN'})`,
    };
  }
  if (typeof req.lineUserId === 'string' && req.lineUserId.length > 0) {
    return {
      kind: IncidentCallerKind.LINE_USER,
      label: `line-user:${maskLineId(req.lineUserId)}`,
    };
  }
  if (typeof req.path === 'string' && req.path.endsWith('/line/webhook')) {
    return {
      kind: IncidentCallerKind.LINE_PLATFORM,
      label: 'LINE Platform (webhook)',
    };
  }
  return { kind: IncidentCallerKind.ANONYMOUS, label: 'anonymous' };
}

function templateOf(req: RequestLike | null): string | null {
  const p = req?.route?.path;
  return typeof p === 'string' ? p : null;
}

function paramsOf(req: RequestLike | null): Record<string, string> {
  const out: Record<string, string> = {};
  const params = req?.params;
  if (!params) return out;
  for (const [k, v] of Object.entries(params).slice(0, 8)) {
    out[k] = scrub(String(v)).slice(0, PARAM_MAX);
  }
  return out;
}

/** The route template with each `:param` replaced by its scrubbed, bounded value. No query string. */
function pathOf(req: RequestLike | null): string | null {
  if (!req) return null;
  const template = templateOf(req);
  if (template) {
    const params = paramsOf(req);
    return template.replace(/:([A-Za-z0-9_]+)\??/g, (m, name: string) =>
      name in params ? params[name] : m,
    );
  }
  return typeof req.path === 'string' ? scrub(req.path).slice(0, 200) : null;
}

function ipOf(req: RequestLike | null): string | null {
  if (!req) return null;
  const ip = req.ips && req.ips.length > 0 ? req.ips[0] : req.ip;
  return typeof ip === 'string' && ip.length > 0 ? ip.slice(0, 64) : null;
}

function userAgentOf(req: RequestLike | null): string | null {
  const ua = req?.headers?.['user-agent'];
  const value = Array.isArray(ua) ? ua[0] : ua;
  return typeof value === 'string' && value.length > 0
    ? scrub(value).slice(0, UA_MAX)
    : null;
}

const CONTEXT_STRING_KEYS = [
  'operation',
  'lineErrorKind',
  'prismaCode',
  'sqlState',
  'prismaTarget',
  'bucket',
  'keyPrefix',
] as const;
const CONTEXT_NUMBER_KEYS = [
  'attempt',
  'attempts',
  'latencyMs',
  'budgetMs',
  'upstreamStatus',
  'suppressedCount',
] as const;

/** Copies ONLY the whitelisted keys, with a type check on each. */
export function contextOf(
  input: IncidentContext | undefined,
  params: Record<string, string>,
): IncidentContext {
  const out: IncidentContext = {};
  for (const key of CONTEXT_STRING_KEYS) {
    const v = input?.[key];
    if (typeof v === 'string') out[key] = scrub(v).slice(0, 100);
  }
  for (const key of CONTEXT_NUMBER_KEYS) {
    const v = input?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  if (Object.keys(params).length > 0) out.params = params;
  return out;
}

export interface BuildRecordInput {
  draft: IncidentDraft;
  req: RequestLike | null;
  traceId: string;
  status: number | null;
  method: string | null;
}

export function buildRecord(input: BuildRecordInput): IncidentDraftRecord {
  const { draft, req } = input;
  const error = draft.error;
  const message =
    error !== undefined
      ? messageOf(error)
      : scrub(
          draft.message ??
            `${draft.operation ?? 'external call'} (${COMPONENT_LABEL[draft.component]})`,
        ).slice(0, MESSAGE_MAX);
  return {
    traceId: input.traceId,
    atMs: draft.atMs,
    severity: draft.severity,
    component: draft.component,
    status: input.status,
    method: input.method,
    routeTemplate: templateOf(req),
    path: pathOf(req),
    queryKeys:
      req?.query && typeof req.query === 'object'
        ? Object.keys(req.query).slice(0, 20)
        : [],
    errorCode: draft.errorCode ?? null,
    message,
    stack: stackOf(error),
    caller: callerOf(req, draft.component, draft.operation),
    ip: ipOf(req),
    userAgent: userAgentOf(req),
    context: contextOf(
      { operation: draft.operation, ...draft.context },
      paramsOf(req),
    ),
  };
}
