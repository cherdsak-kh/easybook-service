import { AppAccess } from '@prisma/client';

/**
 * The ADMIN access-transition matrix as a single PURE predicate (design §3, AC-3.1). No Prisma, no
 * I/O — unit-testable in isolation, mirroring the "authz is a pure function" discipline of
 * `system-users.policy.ts`, but co-located in `src/line/` (which has no AC-X3 `SystemRole` grep
 * constraint).
 *
 *   canAdminSetAccess(from, to) =
 *     to === REJECTED
 *       ? (from ∈ {PENDING, ALLOWED, BLOCKED})              // Reject: never from UNREGISTERED
 *       : (to ∈ {ALLOWED, BLOCKED}) && (from ≠ UNREGISTERED) // dropdown targets, unchanged
 *
 * This reproduces the PO matrix EXACTLY, and nothing more:
 *
 *   | from \ to     | ALLOWED         | BLOCKED         | REJECTED       | PENDING | UNREGISTERED |
 *   | PENDING       | ✅ approve       | ✅ block         | ✅ reject       | ❌       | ❌            |
 *   | ALLOWED       | ✅ (idempotent)  | ✅ block         | ✅ reject       | ❌       | ❌            |
 *   | BLOCKED       | ✅ reinstate     | ✅ (idempotent)  | ✅ reject       | ❌       | ❌            |
 *   | REJECTED      | ✅ approve       | ✅ block         | ❌ (see below)  | ❌       | ❌            |
 *   | UNREGISTERED  | ❌               | ❌               | ❌ (nothing)    | ❌       | ❌            |
 *
 * - The four PO transitions (PENDING→ALLOWED, PENDING→BLOCKED, ALLOWED→BLOCKED, BLOCKED→ALLOWED)
 *   are all ✅; dropdown-selectable targets stay strictly {ALLOWED, BLOCKED}.
 * - ADMIN may NOT set UNREGISTERED or PENDING (any such `to` → ❌), nor act from UNREGISTERED (❌).
 * - The two same-state ✅ cells (ALLOWED→ALLOWED, BLOCKED→BLOCKED) are DELIBERATELY permitted so an
 *   ADMIN can retry a 502: after a rich-menu-apply failure the DB is already at the target state, and
 *   the only way to re-drive the LINE side-effect is to re-send the same `access`. This is the design's
 *   one intentional extension beyond the literal four pairs — required, not scope creep.
 * - REJECTED is NEVER a dropdown value — it is reached only by the Reject action (`access: REJECTED` +
 *   `reason`). This predicate lets that action through for ADMIN from {PENDING, ALLOWED, BLOCKED}.
 * - `REJECTED → REJECTED` is ❌ for ADMIN (design §3): a re-reject has no rich-menu side-effect and no
 *   502 path, so there is no retry rationale — allowing it would only re-push a reason with no state
 *   change (notification spam). SUPER_ADMIN may still force it (bypasses this predicate), bound by the
 *   service-level reason + `from ≠ UNREGISTERED` guards which hold for SUPER_ADMIN too.
 *
 * SUPER_ADMIN is NOT bound by this predicate — the caller (`LineUserService.updateAccess`) bypasses it
 * entirely for SUPER_ADMIN (any→any, including forcing UNREGISTERED/PENDING and soft-deleted rows).
 * The `→REJECTED` transition additionally requires a service-level reason + `from ≠ UNREGISTERED`
 * (see `updateAccess`), which apply to SUPER_ADMIN as well.
 */
export const canAdminSetAccess = (from: AppAccess, to: AppAccess): boolean =>
  to === AppAccess.REJECTED
    ? from === AppAccess.PENDING ||
      from === AppAccess.ALLOWED ||
      from === AppAccess.BLOCKED
    : (to === AppAccess.ALLOWED || to === AppAccess.BLOCKED) &&
      from !== AppAccess.UNREGISTERED;
