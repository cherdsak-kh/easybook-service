import { SystemRole } from '@prisma/client';

/**
 * THE authorization matrix for `/system-users`. One file. Pure functions. No Prisma, no Nest,
 * no I/O. The service throws; the policy only decides.
 *
 * Every escalation bug in a user-management API starts as an authz check duplicated in two
 * places that later drift. `RolesGuard` stays coarse (role only); everything that needs the
 * *target row* lives here and is called inside the write's transaction, so authz and write are
 * serializable-consistent.
 */

export interface Actor {
  id: string;
  role: SystemRole;
}

export interface Target {
  id: string;
  role: SystemRole;
}

/** Only the two invariant-bearing fields matter to the policy; profile fields are irrelevant. */
export interface Patch {
  role?: SystemRole;
  isActive?: boolean;
}

export type PolicyResult =
  { allowed: true } | { allowed: false; reason: string };

const deny = (reason: string): PolicyResult => ({ allowed: false, reason });
const allow = (): PolicyResult => ({ allowed: true });

export const CANNOT_CHANGE_OWN_ROLE = 'You cannot change your own role.';
export const CANNOT_CHANGE_OWN_ACTIVE_STATUS =
  'You cannot change your own active status.';
export const CANNOT_DELETE_OWN_ACCOUNT = 'You cannot delete your own account.';
export const ONLY_SUPER_ADMIN_MAY_CHANGE_ROLE =
  'Only a SUPER_ADMIN may change a role.';
export const ADMIN_MAY_ONLY_MODIFY_STAFF =
  'An ADMIN may only modify STAFF users.';
export const ONLY_SUPER_ADMIN_MAY_DELETE =
  'Only a SUPER_ADMIN may delete a user.';
export const INSUFFICIENT_ROLE = 'Insufficient role.';
export const CANNOT_RESET_OWN_PASSWORD =
  'You cannot reset your own password. Use the change-password endpoint instead.';

/**
 * May this actor see and assign the SYSTEM-RESERVED options (the System Developer department /
 * role)? SUPER_ADMIN only.
 *
 * The ONE role -> capability fact behind the reserved-option boundary. It lives here, with the rest
 * of the matrix, so no second copy can drift: read by both option controllers (to decide whether a
 * list includes reserved rows) and by SystemUsersService (to decide whether a write may reference
 * one).
 *
 * Pure, per this file's charter. The companion question — "is option id N reserved?" — is a DB
 * attribute lookup, i.e. VALIDATION, and stays in the service beside assertOptionsAssignable, which
 * has the same shape and the same reasoning. See 02_design_log.md §3.
 *
 * Returns a raw boolean, not a PolicyResult: its callers ask "may I?" (to build a `where` / choose a
 * filter), not "reject with what reason?". A denied actor gets the SAME 400/404 as for a nonexistent
 * option — never a 403, which would be an existence oracle — so a `reason` field would be dead weight
 * and an invitation to surface it. The canX functions return PolicyResult because their reasons ARE
 * returned as 403 bodies. This one must never be.
 *
 * NOTE: this file is no longer read only by /system-users. It is now the back-office authorization
 * matrix, full stop. That is deliberate and is the opposite of duplication.
 */
export function mayUseSystemReservedOptions(actor: Actor): boolean {
  return actor.role === SystemRole.SUPER_ADMIN;
}

export function canPatch(
  actor: Actor,
  target: Target,
  patch: Patch,
): PolicyResult {
  // ── Step 5: self-mutation. Binds EVERY role, including SUPER_ADMIN. Evaluated FIRST. ──
  if (actor.id === target.id) {
    // Compare ids, never emails.
    if (patch.role !== undefined) return deny(CANNOT_CHANGE_OWN_ROLE);
    if (patch.isActive !== undefined)
      return deny(CANNOT_CHANGE_OWN_ACTIVE_STATUS);
  }

  // ── Step 6: the matrix. `role` is SUPER_ADMIN-write-only, rejected on KEY PRESENCE. ──
  // `patch.role !== undefined` is an exact presence test because `{"role": null}` already 400'd
  // at the pipe (DD-11). There is no harmless no-op probe: `role: "STAFF"` on a STAFF target,
  // sent by an ADMIN, is denied here before the target's role is even consulted (AC-44).
  if (patch.role !== undefined && actor.role !== SystemRole.SUPER_ADMIN) {
    return deny(ONLY_SUPER_ADMIN_MAY_CHANGE_ROLE);
  }

  switch (actor.role) {
    case SystemRole.SUPER_ADMIN:
      return allow();
    case SystemRole.ADMIN:
      // An ADMIN may address a STAFF target only — which already implies "may write isActive on
      // a STAFF target only". A second explicit check would be the duplicated authz that drifts.
      return target.role === SystemRole.STAFF
        ? allow()
        : deny(ADMIN_MAY_ONLY_MODIFY_STAFF);
    default:
      // Unreachable: RolesGuard already rejected STAFF. Defence in depth against a future
      // @Roles(...) widening, and cheap. The spec covers it by calling the policy directly.
      return deny(INSUFFICIENT_ROLE);
  }
}

export function canDelete(actor: Actor, target: Target): PolicyResult {
  if (actor.id === target.id) return deny(CANNOT_DELETE_OWN_ACCOUNT);
  // Unreachable: @Roles(SUPER_ADMIN) fires before the target is even loaded.
  if (actor.role !== SystemRole.SUPER_ADMIN)
    return deny(ONLY_SUPER_ADMIN_MAY_DELETE);
  return allow();
}

/**
 * `POST /system-users/:id/reset-password`. SUPER_ADMIN-only (enforced coarsely by `@Roles`); the one
 * target-dependent rule is "not yourself".
 *
 * A SUPER_ADMIN resetting themselves would burn their own working password and put themselves behind
 * the forced-reset gate for no reason — the same class of foot-gun as `canDelete`'s self-rule, and
 * consistent with it. It is not a lockout (they hold the temp password), but `POST /auth/system/password`
 * is the correct door.
 */
export function canResetPassword(actor: Actor, target: Target): PolicyResult {
  if (actor.id === target.id) return deny(CANNOT_RESET_OWN_PASSWORD);
  // Unreachable: @Roles(SUPER_ADMIN) fires before the target is even loaded. Defence in depth.
  if (actor.role !== SystemRole.SUPER_ADMIN) return deny(INSUFFICIENT_ROLE);
  return allow();
}
