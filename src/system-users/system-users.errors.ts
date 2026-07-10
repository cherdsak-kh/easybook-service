/** One constant per message, so two branches can never drift apart. */

export const SYSTEM_USER_NOT_FOUND = 'System user not found.';
export const LAST_SUPER_ADMIN = 'Cannot remove the last active SUPER_ADMIN.';
export const USER_NOT_DELETED = 'User is not deleted.';
export const CONCURRENT_MODIFICATION =
  'The user was modified concurrently. Please retry.';
export const EMAIL_TAKEN = 'A system user with this email already exists.';
