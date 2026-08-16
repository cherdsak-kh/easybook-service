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
  /**
   * The id of the account that CREATED this actor, or `null` for the bootstrapped first
   * SUPER_ADMIN. Read only by `mayNotManageOwnCreator` — see it for why the policy needs it.
   *
   * Comes from `PUBLIC_FIELDS`' `createdBy` select (which carries no filter, by DD-4, so a
   * soft-deleted creator still resolves and the rule still fires).
   */
  createdById: string | null;
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
export const ADMIN_MAY_ONLY_MODIFY_VIEWER =
  'An ADMIN may only modify VIEWER users.';
export const ONLY_SUPER_ADMIN_MAY_DELETE =
  'Only a SUPER_ADMIN may delete a user.';
export const INSUFFICIENT_ROLE = 'Insufficient role.';
export const CANNOT_RESET_OWN_PASSWORD =
  'You cannot reset your own password. Use the change-password endpoint instead.';
export const CANNOT_MANAGE_OWN_CREATOR =
  'You cannot manage the account that created yours.';

/**
 * STAFF-CREATOR-1 — **you may not manage the account that created you.**
 *
 * Two SUPER_ADMINs are peers in every other respect, which means the account that installed the
 * system can be demoted, suspended, deleted or password-reset by an account it created minutes
 * earlier. `canPatch`'s `case SUPER_ADMIN` was a bare `allow()`, and `canDelete` only ever asked
 * "is this me?".
 *
 * ⚠️ ONE HOP, exactly as specified: your creator, not your creator's creator. So in a chain where
 * ธีรพงษ์ created เชิดศักดิ์ who created วีระ, วีระ may still manage ธีรพงษ์. That consequence is
 * deliberately visible on the designed screen rather than hidden, so the PO can decide whether the
 * rule should eventually walk the whole ancestor chain — which is a different rule with different
 * costs, not an obvious extension of this one.
 *
 * Binds EVERY role, SUPER_ADMIN included: a rule that the most privileged role can skip is not a
 * rule about privilege, and this one is about provenance.
 *
 * A `null` creator (the bootstrapped first SUPER_ADMIN) never matches, which is correct — nobody
 * created them, so there is nothing to protect.
 */
function mayNotManageOwnCreator(actor: Actor, target: Target): boolean {
  return actor.createdById !== null && actor.createdById === target.id;
}

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
  // ── STAFF-CREATOR-1. Before the matrix, because it binds every role including SUPER_ADMIN. ──
  if (mayNotManageOwnCreator(actor, target)) {
    return deny(CANNOT_MANAGE_OWN_CREATOR);
  }

  // ── Step 5: self-mutation. Binds EVERY role, including SUPER_ADMIN. Evaluated FIRST. ──
  if (actor.id === target.id) {
    // Compare ids, never emails.
    if (patch.role !== undefined) return deny(CANNOT_CHANGE_OWN_ROLE);
    if (patch.isActive !== undefined)
      return deny(CANNOT_CHANGE_OWN_ACTIVE_STATUS);
  }

  // ── Step 6: the matrix. `role` is SUPER_ADMIN-write-only, rejected on KEY PRESENCE. ──
  // `patch.role !== undefined` is an exact presence test because `{"role": null}` already 400'd
  // at the pipe (DD-11). There is no harmless no-op probe: `role: "VIEWER"` on a VIEWER target,
  // sent by an ADMIN, is denied here before the target's role is even consulted (AC-44).
  if (patch.role !== undefined && actor.role !== SystemRole.SUPER_ADMIN) {
    return deny(ONLY_SUPER_ADMIN_MAY_CHANGE_ROLE);
  }

  switch (actor.role) {
    case SystemRole.SUPER_ADMIN:
      return allow();
    case SystemRole.ADMIN:
      // An ADMIN may address a VIEWER target — which already implies "may write isActive on a
      // VIEWER target only", so a second explicit check would be the duplicated authz that
      // drifts — OR their OWN row (SELF-PROFILE-2, PO-approved; it removes an asymmetry with
      // `case SUPER_ADMIN`, which has always permitted a self-patch).
      //
      // THREE things about the second disjunct, each of which a "simplification" would break:
      //
      //  1. It compares IDS, never roles and never emails. An ADMIN patching a DIFFERENT ADMIN
      //     (or a SUPER_ADMIN) is still denied — there is no ADMIN -> ADMIN lateral widening.
      //  2. It stays scoped INSIDE this case. Hoisting `if (actor.id === target.id) allow()`
      //     above the switch would place it in front of `default:`, so a future @Roles(...)
      //     widening to VIEWER would silently hand VIEWER a self-edit capability while the
      //     defence-in-depth arm that exists to catch that widening never ran.
      //  3. It does NOT re-check `role` / `isActive`. Step 5 runs FIRST and already denied a
      //     self-patch carrying either key, so this branch is unreachable for them. A second
      //     copy would duplicate the rule AND replace the 403 reason the frontend and the e2e
      //     suite assert on (CANNOT_CHANGE_OWN_ROLE / CANNOT_CHANGE_OWN_ACTIVE_STATUS).
      //
      // The newly reachable consequence: an ADMIN self-patch now reaches the service's
      // `assertOptionsAssignable`, where a SYSTEM-RESERVED departmentId/personnelRoleId is the
      // same 400 as an unknown id — never a 403. That boundary is unchanged; it is simply
      // reachable for the first time.
      return target.role === SystemRole.VIEWER || actor.id === target.id
        ? allow()
        : deny(ADMIN_MAY_ONLY_MODIFY_VIEWER);
    default:
      // Unreachable: RolesGuard already rejected VIEWER. Defence in depth against a future
      // @Roles(...) widening, and cheap. The spec covers it by calling the policy directly.
      return deny(INSUFFICIENT_ROLE);
  }
}

export function canDelete(actor: Actor, target: Target): PolicyResult {
  if (actor.id === target.id) return deny(CANNOT_DELETE_OWN_ACCOUNT);
  if (mayNotManageOwnCreator(actor, target)) {
    return deny(CANNOT_MANAGE_OWN_CREATOR);
  }
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
  // Resetting your creator's password is the sharpest form of the thing STAFF-CREATOR-1 stops:
  // it hands you their account, since the reset returns a temporary password to YOU.
  if (mayNotManageOwnCreator(actor, target)) {
    return deny(CANNOT_MANAGE_OWN_CREATOR);
  }
  // Unreachable: @Roles(SUPER_ADMIN) fires before the target is even loaded. Defence in depth.
  if (actor.role !== SystemRole.SUPER_ADMIN) return deny(INSUFFICIENT_ROLE);
  return allow();
}
