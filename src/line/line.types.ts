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
  /**
   * The caller's LINE display name and picture, as they were when this ID token was minted.
   *
   * ⚠️ IT IS NOT AN IDENTITY AND MUST NEVER BE READ AS ONE. `lineUserId` above is the only field
   * that answers "who is this"; these two are display data that happens to arrive on the same
   * verified payload. They are here for exactly one job — keeping our copy of a follower's LINE
   * profile current — because LINE has no "profile changed" webhook event, so the only moments we
   * can learn about a rename are the moments the user shows up carrying fresh data.
   *
   * ⚠️ ABSENT IS NORMAL, not an error. The claims ride on the ID token only when it was minted
   * with the `profile` scope; a LIFF app configured without it verifies perfectly and yields
   * nothing here. Callers must treat `undefined` as "no news", never as "the user cleared it" —
   * writing `null` on absence would erase a good name every time the scope was missing.
   */
  lineProfile?: LineProfileClaims;
}

/** The display half of a verified LINE ID token. See `RequestWithLineUserId.lineProfile`. */
export interface LineProfileClaims {
  displayName?: string;
  pictureUrl?: string;
}
