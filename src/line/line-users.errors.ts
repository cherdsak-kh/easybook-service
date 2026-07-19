/**
 * One constant per message, so two branches can never drift apart (mirrors
 * `system-users.errors.ts`).
 *
 * The 404 message is deliberately generic: an unknown id and a soft-deleted id must return a
 * byte-identical body, revealing nothing about deletion (design §3.2, AC-B10).
 */
export const LINE_USER_NOT_FOUND = 'LINE user not found.';

/**
 * The admin `PATCH /line-users/:id/registration` target exists (and, for an ADMIN, is not
 * soft-deleted) but has no `LineUserRegistration` row to edit (an UNREGISTERED follower, or any row
 * lacking a registration). A **404 with a distinct message** — NOT an existence leak: it is only
 * reachable AFTER the user is confirmed to exist, and admins already see `registration: null` on the
 * list. Returned instead of a 500 when there is nothing to update.
 */
export const LINE_USER_REGISTRATION_NOT_FOUND =
  'This LINE user has no registration to edit.';

/**
 * `updateAccess` writes the DB first, then applies the derived rich menu on LINE. A LINE-apply
 * failure surfaces as a retryable 502 (design §4); the DB `access`/`richMenuType` are already the
 * source of truth, and a re-approve/re-block is idempotent.
 */
export const LINE_RICH_MENU_APPLY_FAILED =
  'Failed to apply the LINE rich menu. Please retry.';

/**
 * An ADMIN attempted an access transition the matrix forbids (design §3, AC-3.2). The body is
 * well-formed and the enum value is valid — it is the actor's ROLE that is not permitted to make this
 * transition, so the status is 403 (authorization limit), NOT 400. Reachable only AFTER the 404
 * precedence check, so it never leaks the existence of an unknown/soft-deleted row. SUPER_ADMIN never
 * hits this (it bypasses the predicate entirely).
 */
export const LINE_USER_ACCESS_TRANSITION_FORBIDDEN =
  'You are not permitted to make this status change.';

/**
 * Registration conflicts (design §3.1). Distinct messages so the frontend can tell the two apart:
 * the caller already has a registration vs. the submitted ID belongs to someone else.
 */
export const ALREADY_REGISTERED = 'This LINE user is already registered.';
export const STAFF_ID_TAKEN = 'This staff ID is already registered.';

/**
 * A chosen `departmentId`/`personnelRoleId` did not resolve to a NON-DELETED option (SC-3.2/SC-B6).
 * A soft-deleted or unknown option is a client-side validation failure → `400`, not a `409`
 * (the app has no `422` convention). Distinct messages so the frontend can flag the right field.
 */
export const INVALID_DEPARTMENT = 'The selected department is not available.';
export const INVALID_PERSONNEL_ROLE =
  'The selected personnel role is not available.';

/**
 * The PENDING-only self-edit gate (SC-3.3/SC-B9). An authorization-by-state rejection (403),
 * distinct from register's duplicate-resource `409`: only a caller whose `access` is strictly
 * `PENDING` may edit their registration. Deterministic, with no partial write.
 */
export const REGISTRATION_NOT_EDITABLE =
  'Your registration can only be edited while it is pending review.';
