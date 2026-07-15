/**
 * One constant per message, so two branches can never drift apart (mirrors
 * `system-users.errors.ts`).
 *
 * The 404 message is deliberately generic: an unknown id and a soft-deleted id must return a
 * byte-identical body, revealing nothing about deletion (design §3.2, AC-B10).
 */
export const LINE_USER_NOT_FOUND = 'LINE user not found.';

/**
 * `updateAccess` writes the DB first, then applies the derived rich menu on LINE. A LINE-apply
 * failure surfaces as a retryable 502 (design §4); the DB `access`/`richMenuType` are already the
 * source of truth, and a re-approve/re-block is idempotent.
 */
export const LINE_RICH_MENU_APPLY_FAILED =
  'Failed to apply the LINE rich menu. Please retry.';

/**
 * Registration conflicts (design §3.1). Distinct messages so the frontend can tell the two apart:
 * the caller already has a registration vs. the submitted ID belongs to someone else.
 */
export const ALREADY_REGISTERED = 'This LINE user is already registered.';
export const STUDENT_STAFF_ID_TAKEN =
  'This student/staff ID is already registered.';
