import { AppAccess } from '@prisma/client';
import { canAdminSetAccess } from './line-access.policy';

describe('canAdminSetAccess (ADMIN transition matrix)', () => {
  // The full 5x5 truth table (design §3). ✅ = the four PO pairs + the two idempotent same-state
  // writes (ALLOWED→ALLOWED, BLOCKED→BLOCKED) needed for a 502 retry + the Reject targets
  // (PENDING/ALLOWED/BLOCKED → REJECTED); everything else is ❌. REJECTED → REJECTED is ❌ for ADMIN
  // (re-reject is not via the ADMIN policy — §3 decision); REJECTED → ALLOWED/BLOCKED is ✅.
  const CASES: Array<[AppAccess, AppAccess, boolean]> = [
    // from PENDING
    [AppAccess.PENDING, AppAccess.ALLOWED, true],
    [AppAccess.PENDING, AppAccess.BLOCKED, true],
    [AppAccess.PENDING, AppAccess.REJECTED, true],
    [AppAccess.PENDING, AppAccess.PENDING, false],
    [AppAccess.PENDING, AppAccess.UNREGISTERED, false],
    // from ALLOWED
    [AppAccess.ALLOWED, AppAccess.ALLOWED, true],
    [AppAccess.ALLOWED, AppAccess.BLOCKED, true],
    [AppAccess.ALLOWED, AppAccess.REJECTED, true],
    [AppAccess.ALLOWED, AppAccess.PENDING, false],
    [AppAccess.ALLOWED, AppAccess.UNREGISTERED, false],
    // from BLOCKED
    [AppAccess.BLOCKED, AppAccess.ALLOWED, true],
    [AppAccess.BLOCKED, AppAccess.BLOCKED, true],
    [AppAccess.BLOCKED, AppAccess.REJECTED, true],
    [AppAccess.BLOCKED, AppAccess.PENDING, false],
    [AppAccess.BLOCKED, AppAccess.UNREGISTERED, false],
    // from REJECTED — a reviewer may approve/block a rejected user directly, but ADMIN may NOT
    // re-reject (REJECTED→REJECTED is false; SUPER_ADMIN forces it via the bypass, not this predicate)
    [AppAccess.REJECTED, AppAccess.ALLOWED, true],
    [AppAccess.REJECTED, AppAccess.BLOCKED, true],
    [AppAccess.REJECTED, AppAccess.REJECTED, false],
    [AppAccess.REJECTED, AppAccess.PENDING, false],
    [AppAccess.REJECTED, AppAccess.UNREGISTERED, false],
    // from UNREGISTERED — every target is ❌ (approving/rejecting a user with no registration is
    // meaningless; UNREGISTERED→REJECTED is false — nothing to reject)
    [AppAccess.UNREGISTERED, AppAccess.ALLOWED, false],
    [AppAccess.UNREGISTERED, AppAccess.BLOCKED, false],
    [AppAccess.UNREGISTERED, AppAccess.REJECTED, false],
    [AppAccess.UNREGISTERED, AppAccess.PENDING, false],
    [AppAccess.UNREGISTERED, AppAccess.UNREGISTERED, false],
  ];

  it.each(CASES)('%s→%s = %s', (from, to, expected) => {
    expect(canAdminSetAccess(from, to)).toBe(expected);
  });

  it('is pure: the same inputs always return the same result (no I/O, no state)', () => {
    expect(canAdminSetAccess(AppAccess.PENDING, AppAccess.ALLOWED)).toBe(
      canAdminSetAccess(AppAccess.PENDING, AppAccess.ALLOWED),
    );
  });

  it('permits ONLY ALLOWED/BLOCKED as a plain (dropdown) target — never PENDING/UNREGISTERED', () => {
    // REJECTED is NOT a dropdown target — it is reached only via the Reject action, tested above.
    for (const from of Object.values(AppAccess)) {
      expect(canAdminSetAccess(from, AppAccess.PENDING)).toBe(false);
      expect(canAdminSetAccess(from, AppAccess.UNREGISTERED)).toBe(false);
    }
  });

  it('permits REJECTED only from a reviewable state ({PENDING, ALLOWED, BLOCKED}), never UNREGISTERED or REJECTED', () => {
    expect(canAdminSetAccess(AppAccess.PENDING, AppAccess.REJECTED)).toBe(true);
    expect(canAdminSetAccess(AppAccess.ALLOWED, AppAccess.REJECTED)).toBe(true);
    expect(canAdminSetAccess(AppAccess.BLOCKED, AppAccess.REJECTED)).toBe(true);
    expect(canAdminSetAccess(AppAccess.UNREGISTERED, AppAccess.REJECTED)).toBe(
      false,
    );
    expect(canAdminSetAccess(AppAccess.REJECTED, AppAccess.REJECTED)).toBe(
      false,
    );
  });
});
