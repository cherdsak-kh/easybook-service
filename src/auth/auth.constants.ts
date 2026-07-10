/**
 * A single message for every login failure — unknown email, wrong password, suspended account,
 * and soft-deleted account. Four branches, one constant, so they cannot drift apart (AC-6, AC-31).
 */
export const INVALID_CREDENTIALS = 'Invalid email or password.';

export const AUTHENTICATION_REQUIRED = 'Authentication required.';

/**
 * Hard cap on session lifetime, independent of the rolling idle window (D-6).
 * A code constant, not an env var — T-6's variable list is exhaustive.
 */
export const SESSION_ABSOLUTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Both login limits: 15-minute window, blocked for the remainder of that window. */
export const LOGIN_THROTTLE_TTL_MS = 15 * 60 * 1000;
export const LOGIN_IP_EMAIL_LIMIT = 5;
export const LOGIN_IP_LIMIT = 20;
