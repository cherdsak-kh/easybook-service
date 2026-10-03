/**
 * Hub 6 (บันทึกข้อผิดพลาด) — every tunable in one place. No env vars (design §2.5.1: no devops work).
 */

/** Ring-buffer cap (PO ruling OQ-P3-2): the oldest incident is dropped beyond this many. */
export const INCIDENT_CAP = 5000;
/** Age cap: an incident older than this is dropped, whichever of the two caps trips first. */
export const INCIDENT_MAX_AGE_DAYS = 90;
/** `DELETE /reports/error-log` purges incidents older than this many Bangkok days (D-24). */
export const INCIDENT_PURGE_KEEP_DAYS = 30;
/** The per-process outage buffer used while the Redis client is not `ready` (D-22). */
export const INCIDENT_FIFO = 200;
/** Day counters (`metrics:req:` / `metrics:5xx:`) live this long. */
export const METRIC_TTL_DAYS = 100;
/** A successful LINE / R2 call slower than this is a WARNING. */
export const LINE_SLOW_MS = 3000;
export const R2_SLOW_MS = 3000;
/** Storm control (E-13): at most this many stored incidents per signature per window. */
export const SIGNATURE_LIMIT = 20;
export const SIGNATURE_WINDOW_MS = 60_000;
/** Redaction caps (D-21). */
export const MESSAGE_MAX = 500;
export const STACK_MAX_LINES = 50;
export const STACK_MAX_BYTES = 8192;
export const UA_MAX = 300;
export const PARAM_MAX = 64;
/** Drafts one request may collect before the rest are dropped (a loop calling LINE must not balloon). */
export const DRAFTS_PER_REQUEST_MAX = 20;
/** A store failure is logged at most once per this window. */
export const STORE_WARN_INTERVAL_MS = 60_000;

/** Inbound `X-Request-Id` is reused only when it matches this (D-18): log/header injection is impossible. */
export const TRACE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
export const REQUEST_ID_HEADER = 'X-Request-Id';
/** `res.locals` key under which the trace context travels to the filter. */
export const TRACE_CTX = 'eb.trace';

/**
 * Injection token for the keyspace root. `eb:` in every real environment, `eb:test:` under jest so an
 * e2e run never writes the dev server's incident log (and never reads it either).
 */
export const INCIDENT_KEY_ROOT = Symbol('INCIDENT_KEY_ROOT');
export const incidentKeyRootFor = (nodeEnv: string | undefined): string =>
  nodeEnv === 'test' ? 'eb:test:' : 'eb:';
