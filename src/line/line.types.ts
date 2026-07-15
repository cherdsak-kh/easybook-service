import type { Request } from 'express';

/**
 * A request whose caller's LINE identity has been established by `LineIdTokenGuard`.
 *
 * `lineUserId` is the **verified `sub`** from a LINE ID token (LINK-LINE-1): downstream handlers
 * derive the caller's identity ONLY from this field, never from a client-supplied body/param/query
 * value. It is the LINE-side `U…` string (`LineUser.lineUserId`), not the cuid `LineUser.id`.
 */
export interface RequestWithLineUserId extends Request {
  lineUserId?: string;
}
