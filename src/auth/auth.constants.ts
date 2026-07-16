/**
 * A single message for every login failure — unknown email, wrong password, suspended account,
 * and soft-deleted account. Four branches, one constant, so they cannot drift apart (AC-6, AC-31).
 */
export const INVALID_CREDENTIALS = 'Invalid email or password.';

export const AUTHENTICATION_REQUIRED = 'Authentication required.';

/**
 * The forced-reset gate's `403` (AC-B8), raised by `SessionGuard` when `mustChangePassword` is true
 * on a handler that is not `@AllowPasswordChangeGate()`-exempt.
 *
 * AC-B8 asks for "a machine-readable code". The repo's `ErrorResponseDto` is
 * `{ statusCode, error, message }` with NO `code` field anywhere, and introducing one on a single
 * error would create a second error convention for one route. This exported constant is what the
 * specs assert on — machine-readable in the sense that matters here. The frontend does not parse it
 * at all: it routes off `mustChangePassword` from the (exempt) `GET /auth/system/me`, which is
 * strictly more robust than string-matching an error body.
 */
export const MUST_CHANGE_PASSWORD =
  'You must change your password before continuing.';

/**
 * `POST /auth/system/password` failures.
 *
 * `INVALID_CURRENT_PASSWORD` is a **400, never a 401**. The session is valid; only the re-auth
 * failed. A `401` from an authenticated route is the SPA's universal "your session is dead → bounce
 * to login" signal, so returning it here would log the user out for a typo — and, while gated, dump
 * them at a login screen whose password no longer works. `403` is taken by the gate itself.
 */
export const INVALID_CURRENT_PASSWORD = 'Current password is incorrect.';
export const PASSWORD_UNCHANGED =
  'The new password must differ from the current password.';

/**
 * Hard cap on session lifetime, independent of the rolling idle window (D-6).
 * A code constant, not an env var — T-6's variable list is exhaustive.
 */
export const SESSION_ABSOLUTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Both login limits: 15-minute window, blocked for the remainder of that window. */
export const LOGIN_THROTTLE_TTL_MS = 15 * 60 * 1000;
export const LOGIN_IP_EMAIL_LIMIT = 5;
export const LOGIN_IP_LIMIT = 20;
