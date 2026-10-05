import 'express-session';

/**
 * Module augmentation so `req.session.systemUserId` type-checks.
 *
 * The session payload holds an identity id, timestamps and **descriptive sign-in metadata** (`ip`,
 * `userAgent`, read only by the sessions page) — never a role, never a permission set, and the
 * metadata is **never** an authentication input. `SessionGuard` re-reads the `SystemUser` from the
 * database on every authenticated request (D-9), so a demoted or deactivated user loses access on
 * their *next* request rather than at session expiry.
 */
declare module 'express-session' {
  interface SessionData {
    systemUserId?: string;
    /** Epoch ms — the login instant and the anchor for the 24h absolute cap. */
    createdAt?: number;
    /**
     * `resolveIp(req)` at sign-in, <= 64 chars (LOGIN-SESSIONS-1). DESCRIPTIVE ONLY — never an
     * authentication input (no IP binding: CGNAT shares and rotates addresses).
     */
    ip?: string;
    /**
     * User-Agent at sign-in, control characters stripped, <= 512 chars (LOGIN-SESSIONS-1).
     * DESCRIPTIVE ONLY.
     */
    userAgent?: string;
  }
}
