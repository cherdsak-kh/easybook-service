import 'express-session';

/**
 * Module augmentation so `req.session.systemUserId` type-checks.
 *
 * The session payload holds an id and a timestamp — never a role, never a permission set.
 * `SessionGuard` re-reads the `SystemUser` from the database on every authenticated request
 * (D-9), so a demoted or deactivated user loses access on their *next* request rather than at
 * session expiry.
 */
declare module 'express-session' {
  interface SessionData {
    systemUserId?: string;
    /** Epoch ms — the anchor for the 24h absolute cap. */
    createdAt?: number;
  }
}
