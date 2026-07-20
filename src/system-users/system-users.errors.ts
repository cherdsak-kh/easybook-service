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
