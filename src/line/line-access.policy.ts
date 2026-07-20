import { AppAccess } from '@prisma/client';

/**
 * The ADMIN access-transition matrix as a single PURE predicate (design §3, AC-3.1). No Prisma, no
 * I/O — unit-testable in isolation, mirroring the "authz is a pure function" discipline of
 * `system-users.policy.ts`, but co-located in `src/line/` (which has no AC-X3 `SystemRole` grep
 * constraint).
 *
 *   canAdminSetAccess(from, to) = (to ∈ {ALLOWED, BLOCKED}) && (from ≠ UNREGISTERED)
 *
 * This reproduces the PO matrix EXACTLY, and nothing more:
 *
 *   | from \ to     | ALLOWED         | BLOCKED         | PENDING | UNREGISTERED |
 *   | PENDING       | ✅ approve       | ✅ block         | ❌       | ❌            |
 *   | ALLOWED       | ✅ (idempotent)  | ✅ block         | ❌       | ❌            |
 *   | BLOCKED       | ✅ reinstate     | ✅ (idempotent)  | ❌       | ❌            |
 *   | UNREGISTERED  | ❌               | ❌               | ❌       | ❌            |
 *
 * - The four PO transitions (PENDING→ALLOWED, PENDING→BLOCKED, ALLOWED→BLOCKED, BLOCKED→ALLOWED)
 *   are all ✅.
 * - ADMIN may NOT set UNREGISTERED or PENDING (any such `to` → ❌), nor act from UNREGISTERED (❌).
 * - The two same-state ✅ cells (ALLOWED→ALLOWED, BLOCKED→BLOCKED) are DELIBERATELY permitted so an
 *   ADMIN can retry a 502: after a rich-menu-apply failure the DB is already at the target state, and
 *   the only way to re-drive the LINE side-effect is to re-send the same `access`. This is the design's
 *   one intentional extension beyond the literal four pairs — required, not scope creep.
 *
 * SUPER_ADMIN is NOT bound by this predicate — the caller (`LineUserService.updateAccess`) bypasses it
 * entirely for SUPER_ADMIN (any→any, including forcing UNREGISTERED/PENDING and soft-deleted rows).
 */
export const canAdminSetAccess = (from: AppAccess, to: AppAccess): boolean =>
  (to === AppAccess.ALLOWED || to === AppAccess.BLOCKED) &&
  from !== AppAccess.UNREGISTERED;
