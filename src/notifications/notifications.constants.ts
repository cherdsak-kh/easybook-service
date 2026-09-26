/**
 * `NOTIF-API-1` — admin notifications, phase 1. Every literal the module and its tests share.
 */

/**
 * The spec's canonical glyph names (notifications_spec §2), one per use case. **15 values** — the plan
 * said "14" but listed 15, and the prototype `ICO` table has 15 (design §1.3).
 *
 * The prototype's short keys (`warn`, `building`, `adjust`, `bug`) are aliases that exist only in the
 * prototype and the seed's source table. They are NEVER stored: Phase 2 draws the SVG from these names.
 *
 * This is a STRING column validated against this list, not a Prisma enum — Prisma enum members cannot
 * contain `-`, and an UPPER_SNAKE enum would be a third vocabulary between the spec, the column and the
 * SVG table. The DB does not enforce the set; `NotificationsService.create()` does, and it is the
 * column's only writer.
 */
export const ADMIN_NOTIFICATION_ICONS = [
  'user-plus',
  'user-minus',
  'arrow-path',
  'calendar',
  'x-circle',
  'clock',
  'queue-list',
  'check',
  'chat-bubble',
  'exclamation-triangle',
  'link-slash',
  'sparkles',
  'building-office',
  'adjustments-horizontal',
  'bug-ant',
] as const;
export type AdminNotificationIcon = (typeof ADMIN_NOTIFICATION_ICONS)[number];

/** E-1 `limit` ceiling, and the E-5/E-6 `ids` ceiling. */
export const NOTIFICATION_LIMIT_MAX = 50;
export const NOTIFICATION_SEARCH_MAX = 100;

/**
 * cuid v1 — what `@default(cuid())` emits. Body `ids` must match it (a non-cuid is a 400). A PATH id
 * that fails it is short-circuited to the 404, never a 400 (design §3).
 */
export const NOTIFICATION_ID_PATTERN = /^c[a-z0-9]{24}$/;

/** `period` — Asia/Bangkok calendar days (D-5). Absent = all time. */
export const NOTIFICATION_PERIODS = ['today', '7d', '30d'] as const;
export type NotificationPeriod = (typeof NOTIFICATION_PERIODS)[number];

/** Unknown, malformed, role-invisible and dismissed are ONE indistinguishable 404 (never a 403). */
export const NOTIFICATION_NOT_FOUND = 'Notification not found.';

/** E-6's exactly-one rule, a service-level 400 (design S-9 / §3.5). */
export const NOTIFICATION_DISMISS_TARGET =
  'Provide exactly one of `ids` or `allRead: true`.';

// `create()` caps — service-side, because the columns are unbounded `text` (house rule).
export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 1000;
export const NOTIFICATION_CODE_MAX = 64;
export const NOTIFICATION_ACTION_URL_MAX = 512;
export const NOTIFICATION_ACTION_LABEL_MAX = 60;

/** The only prefix a deep link may carry (D-7, open-redirect guard). */
export const NOTIFICATION_ACTION_URL_PREFIX = '/backend/';
