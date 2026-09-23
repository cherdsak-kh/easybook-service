/** One constant per message, so two branches can never drift apart. */

export const SYSTEM_USER_NOT_FOUND = 'System user not found.';
export const LAST_SUPER_ADMIN = 'Cannot remove the last active SUPER_ADMIN.';
export const USER_NOT_DELETED = 'User is not deleted.';
export const CONCURRENT_MODIFICATION =
  'The user was modified concurrently. Please retry.';
export const EMAIL_TAKEN = 'A system user with this email already exists.';

/**
 * A write referencing an option id that does not exist OR is soft-deleted (AC-B3).
 *
 * `400`, not `404`/`409`/`422`: the id is a field of the caller's BODY, so a bad one is a body
 * validation failure. The repo has no `422` convention, and `404` would claim the *staff user* is
 * missing. Matches the LINE register endpoint's identical check.
 */
export const INVALID_DEPARTMENT = 'Department option not found.';
export const INVALID_PERSONNEL_ROLE = 'Personnel role option not found.';

/**
 * `GET /system-users?status=deleted` asked by anyone but a SUPER_ADMIN.
 *
 * A 403 and not an empty list: the caller asked a question they are not allowed to ask, and
 * answering "no results" would be a lie that also teaches them nothing. The screen hides the
 * option for every other role, but hiding an `<option>` is UX — this is the boundary.
 */
export const DELETED_FILTER_IS_SUPER_ADMIN_ONLY =
  'Only a SUPER_ADMIN may list deleted users.';
