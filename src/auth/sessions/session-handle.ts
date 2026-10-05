import { createHmac, hkdfSync } from 'node:crypto';

/**
 * The opaque session HANDLE (R-1, AC-8) — pure, no Nest.
 *
 * The raw `express-session` id is the bearer secret (the cookie carries it, signed), so it must never
 * appear in a response body, a URL path or a log line. The handle is what the API shows instead: an
 * HMAC of the sid under a subkey derived from `SESSION_SECRET`.
 *
 * ⚠️ DOMAIN SEPARATION IS MANDATORY. `express-session` signs the cookie as
 * `s:<sid>.<base64(HMAC-SHA256(SESSION_SECRET, sid))>`, so a naive `HMAC(SESSION_SECRET, sid)` handle
 * would EQUAL the cookie's own signature. HKDF with a fixed `info` string makes the handle key an
 * independent subkey, so a handle is never the cookie's signature and is useless as a cookie.
 */

/** base64url chars → 132 bits. */
export const SESSION_HANDLE_LENGTH = 22;

/** `'others'` (6 chars) can never match, which makes `DELETE …/sessions/others` unambiguous. */
export const SESSION_HANDLE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const HANDLE_KDF_INFO = 'easybook/session-handle/v1';

/** Derived ONCE at boot. Rotating `SESSION_SECRET` logs everyone out anyway, so rotated handles are harmless. */
export const deriveHandleKey = (sessionSecret: string): Buffer =>
  Buffer.from(
    hkdfSync('sha256', sessionSecret, Buffer.alloc(0), HANDLE_KDF_INFO, 32),
  );

export const sessionHandle = (key: Buffer, sid: string): string =>
  createHmac('sha256', key)
    .update(sid)
    .digest('base64url')
    .slice(0, SESSION_HANDLE_LENGTH);
