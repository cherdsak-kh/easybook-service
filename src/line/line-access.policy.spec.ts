import { AppAccess } from '@prisma/client';
import { canAdminSetAccess } from './line-access.policy';

describe('canAdminSetAccess (ADMIN transition matrix)', () => {
  // The full 4x4 truth table (design §3). ✅ = the four PO pairs + the two idempotent same-state
  // writes (ALLOWED→ALLOWED, BLOCKED→BLOCKED) needed for a 502 retry; everything else is ❌.
  const CASES: Array<[AppAccess, AppAccess, boolean]> = [
    // from PENDING
    [AppAccess.PENDING, AppAccess.ALLOWED, true],
    [AppAccess.PENDING, AppAccess.BLOCKED, true],
    [AppAccess.PENDING, AppAccess.PENDING, false],
    [AppAccess.PENDING, AppAccess.UNREGISTERED, false],
    // from ALLOWED
    [AppAccess.ALLOWED, AppAccess.ALLOWED, true],
    [AppAccess.ALLOWED, AppAccess.BLOCKED, true],
    [AppAccess.ALLOWED, AppAccess.PENDING, false],
    [AppAccess.ALLOWED, AppAccess.UNREGISTERED, false],
    // from BLOCKED
    [AppAccess.BLOCKED, AppAccess.ALLOWED, true],
    [AppAccess.BLOCKED, AppAccess.BLOCKED, true],
    [AppAccess.BLOCKED, AppAccess.PENDING, false],
    [AppAccess.BLOCKED, AppAccess.UNREGISTERED, false],
    // from UNREGISTERED — every target is ❌ (approving a user with no registration is meaningless)
    [AppAccess.UNREGISTERED, AppAccess.ALLOWED, false],
    [AppAccess.UNREGISTERED, AppAccess.BLOCKED, false],
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

  it('permits ONLY ALLOWED/BLOCKED as a target', () => {
    for (const from of Object.values(AppAccess)) {
      expect(canAdminSetAccess(from, AppAccess.PENDING)).toBe(false);
      expect(canAdminSetAccess(from, AppAccess.UNREGISTERED)).toBe(false);
    }
  });
});
