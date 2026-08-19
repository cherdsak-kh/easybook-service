/**
 * A single message for every login failure — unknown email, wrong password, suspended account,
 * and soft-deleted account. Four branches, one constant, so they cannot drift apart (AC-6, AC-31).
 */
export const INVALID_CREDENTIALS = 'Invalid email or password.';

/**
 * The 401 for a session that simply is not usable: absent, or past the absolute cap. It is also
 * what an ANONYMOUS caller gets, and that is the point — it says nothing about any account.
 */
export const AUTHENTICATION_REQUIRED = 'Authentication required.';

/**
 * The 401 for a session that RESOLVED to a real account which may no longer be used —
 * `USER_NOT_FOUND` or `USER_REVOKED` (soft-deleted, or `isActive: false`). AUTH-401-REASON.
 *
 * ── Why the two are told apart at all ──
 * They are the same status and the same remedy on the server, but NOT the same remedy for the
 * person: a session that ended is fixed by signing in again, and an account that was suspended or
 * deleted is not fixed by anything the operator can do. One message for both sent them to retry a
 * login that cannot succeed, which is what the PO reported on 19 ส.ค. 2569.
 *
 * ⚠️ WHY THIS IS NOT AN EXISTENCE ORACLE. Reaching this branch requires a session cookie that
 * already resolved to that user id — the caller was that account moments ago. An anonymous caller,
 * or one holding a stale cookie for a session the store no longer has, gets `NO_SESSION` and
 * therefore `AUTHENTICATION_REQUIRED` above. Nothing here can be used to probe whether an address
 * or an id exists; `POST /auth/system/login` still answers `INVALID_CREDENTIALS` for unknown,
 * wrong-password, suspended and deleted alike.
 *
 * ⚠️ DELIBERATELY COARSER THAN THE RESOLVER. `USER_NOT_FOUND` and `USER_REVOKED` collapse into one
 * message because the difference between "the row is gone" and "the row is suspended" changes
 * nothing the reader can do, and publishing it would be disclosure with no purpose.
 *
 * ⚠️ THE MESSAGE IS THE CONTRACT. `ErrorResponseDto` is `{ statusCode, error, message }` with no
 * `code` field anywhere in this repo (see `MUST_CHANGE_PASSWORD` below for why one was not
 * introduced), so the frontend matches on this exact string. Rewording it degrades the dialog to
 * its generic copy — it does not break it — but the string is an interface: change it in both
 * repositories or not at all.
 */
export const ACCOUNT_UNAVAILABLE = 'Account is no longer active.';

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
