import { CANCEL_LEAD_MINUTES_KEY } from '../../bookings/bookings.constants';
// `import type` only — erased at build, so this does not violate the file-level "no VALUE import
// from line/*" rule (design §2.1).
import type { LineErrorKind } from '../../line/line-call-error';

/**
 * DI token for whether {@link AdminNotificationTriggers} is live (design §2.3, D-1).
 *
 * Default binding: `schedulingEnabled(process.env)` — off whenever `NODE_ENV=test` or
 * `JEST_WORKER_ID` is set, exactly like every cron registration. `test/notifications-triggers.e2e-spec.ts`
 * is the ONLY suite that overrides it, via `overrideProvider(ADMIN_NOTIFICATION_TRIGGERS_ENABLED)
 * .useValue(true)` on its own `TestingModuleBuilder` — nothing leaks to any other suite because each
 * builds a fresh module graph.
 */
export const ADMIN_NOTIFICATION_TRIGGERS_ENABLED = Symbol(
  'ADMIN_NOTIFICATION_TRIGGERS_ENABLED',
);

/** Long code lists (U3/B3/B4) truncate at this many entries, plus "และอีก N รายการ". */
export const CODE_LIST_MAX = 10;

/** C1 — one row per LINE-failure `kind` per hour (R-2). */
export const LINE_FAILURE_DEDUPE_TTL_SEC = 3600;

/** C5 — one row per error signature per 15 minutes (R-2). */
export const SERVER_ERROR_DEDUPE_TTL_SEC = 900;

/** The subset of `LineErrorKind` C1 fires on — `REJECTED`/`ALREADY_ACCEPTED` never reach here. */
export type LineFailureKind = Extract<
  LineErrorKind,
  'NOT_CONFIGURED' | 'RATE_LIMITED' | 'TRANSIENT'
>;

/** The filter itself (design §2.5 "C1 filter") — one definition, reused by the trigger and its spec. */
export const isLineFailureKind = (
  kind: LineErrorKind,
): kind is LineFailureKind =>
  kind === 'NOT_CONFIGURED' || kind === 'RATE_LIMITED' || kind === 'TRANSIENT';

/** `RedisService.claimOnce` key for a C1 failure kind. */
export const lineFailureDedupeKey = (kind: LineFailureKind): string =>
  `c1:${kind}`;

/** `RedisService.claimOnce` key for a C5 error signature — the route TEMPLATE, never `req.url`. */
export const serverErrorDedupeKey = (p: {
  method: string;
  routeTemplate: string | null;
  errorCode: string;
  handler: string;
}): string => `c5:${p.method}:${p.routeTemplate ?? p.handler}:${p.errorCode}`;

/** `AppSetting` key `VersionAnnouncer` (C2) reads/writes. It is the row's only writer. */
export const LAST_ANNOUNCED_VERSION_KEY = 'system.last_announced_version';

/**
 * C4's allowlist (R-5): the only `AppSetting` keys `settingChanged()` may ever notify on. Ships with
 * exactly one entry, dormant — no writer exists yet for `booking.cancel_lead_minutes`.
 */
export const SETTING_CHANGE_ALLOWLIST: readonly string[] = [
  CANCEL_LEAD_MINUTES_KEY,
];

/**
 * C4's hard denylist, checked BEFORE the allowlist so a secret's value is never read into a string:
 * any `line.*` key (secrets), or a key whose name contains `token`, `secret` or `password`.
 */
export function isDeniedSettingKey(key: string): boolean {
  return key.startsWith('line.') || /token|secret|password/i.test(key);
}
