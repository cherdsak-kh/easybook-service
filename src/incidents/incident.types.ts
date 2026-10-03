/**
 * Hub 6's domain types. The enums are the wire enums (`dto/incident.dto.ts` re-exports them with
 * `enumName`), declared here so the capture pipeline never imports a DTO file.
 */

export enum IncidentSeverity {
  CRITICAL = 'CRITICAL',
  ERROR = 'ERROR',
  WARNING = 'WARNING',
}

export enum IncidentComponent {
  LINE_OA = 'LINE_OA',
  PRISMA_DB = 'PRISMA_DB',
  CLOUDFLARE_R2 = 'CLOUDFLARE_R2',
  REDIS = 'REDIS',
  AUTH = 'AUTH',
  API = 'API',
}

export enum IncidentCallerKind {
  STAFF = 'STAFF',
  LINE_USER = 'LINE_USER',
  LINE_PLATFORM = 'LINE_PLATFORM',
  ANONYMOUS = 'ANONYMOUS',
  SYSTEM = 'SYSTEM',
}

/** The whitelisted context keys (design §2.5.3) — nothing else can reach the store. */
export interface IncidentContext {
  operation?: string;
  attempt?: number;
  attempts?: number;
  latencyMs?: number;
  budgetMs?: number;
  upstreamStatus?: number;
  lineErrorKind?: string;
  prismaCode?: string;
  sqlState?: string;
  prismaTarget?: string;
  bucket?: string;
  keyPrefix?: string;
  suppressedCount?: number;
  params?: Record<string, string>;
}

export interface IncidentCaller {
  kind: IncidentCallerKind;
  label: string;
}

/** What the ring holds per incident (no stack, no context — design §1.4). */
export interface IncidentSummaryRecord {
  id: string;
  seq: number;
  traceId: string;
  atMs: number;
  severity: IncidentSeverity;
  component: IncidentComponent;
  status: number | null;
  method: string | null;
  path: string | null;
  routeTemplate: string | null;
  message: string;
  caller: IncidentCaller;
  ip: string | null;
}

/** What the detail hash holds. */
export interface IncidentDetailRecord extends IncidentSummaryRecord {
  userAgent: string | null;
  errorCode: string | null;
  queryKeys: string[];
  stack: string | null;
  context: IncidentContext;
}

/** A redacted record that has not been given an id yet (the store mints `id` and `seq`). */
export type IncidentDraftRecord = Omit<IncidentDetailRecord, 'id' | 'seq'>;

/** The slice of an Express request the redactor reads. Everything optional: it must never throw. */
export interface RequestLike {
  method?: string;
  path?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  ips?: string[];
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  systemUser?: { id?: string; role?: string };
  lineUserId?: string;
}

/** An external call's outcome as the wrappers report it (LINE / R2 / Redis). */
export interface ExternalOutcome {
  component: IncidentComponent;
  operation: string;
  /** The error when the call failed. Absent for "succeeded but slow / after a retry". */
  error?: unknown;
  attempts?: number;
  latencyMs?: number;
  budgetMs?: number;
  context?: IncidentContext;
}

/** One classified, not-yet-persisted incident waiting for its request to settle. */
export interface IncidentDraft {
  severity: IncidentSeverity;
  component: IncidentComponent;
  atMs: number;
  error?: unknown;
  errorCode?: string | null;
  /** Overrides the message built from `error` (used for "succeeded, but slowly"). */
  message?: string;
  operation?: string;
  context?: IncidentContext;
}

export interface TraceContext {
  traceId: string;
  startedAt: number;
  method: string;
  req: RequestLike;
  drafts: IncidentDraft[];
  error?: unknown;
  closed: boolean;
}
