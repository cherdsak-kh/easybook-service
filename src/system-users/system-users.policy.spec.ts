import { SystemRole } from '@prisma/client';
import {
  ADMIN_MAY_ONLY_MODIFY_VIEWER,
  Actor,
  CANNOT_CHANGE_OWN_ACTIVE_STATUS,
  CANNOT_CHANGE_OWN_ROLE,
  CANNOT_DELETE_OWN_ACCOUNT,
  INSUFFICIENT_ROLE,
  ONLY_SUPER_ADMIN_MAY_CHANGE_ROLE,
  ONLY_SUPER_ADMIN_MAY_DELETE,
  Patch,
  Target,
  canDelete,
  canPatch,
  mayUseSystemReservedOptions,
} from './system-users.policy';

const ROLES = [
  SystemRole.SUPER_ADMIN,
  SystemRole.ADMIN,
  SystemRole.VIEWER,
] as const;

const actor = (role: SystemRole, id = 'actor'): Actor => ({ id, role });
const target = (role: SystemRole, id = 'target'): Target => ({ id, role });

const PROFILE_ONLY: Patch = {};

/** The §5.1 matrix for `PATCH`, on a *different* target, with a profile-only patch. */
const PATCH_PROFILE_MATRIX: Array<[SystemRole, SystemRole, boolean]> = [
  [SystemRole.SUPER_ADMIN, SystemRole.SUPER_ADMIN, true],
  [SystemRole.SUPER_ADMIN, SystemRole.ADMIN, true],
  [SystemRole.SUPER_ADMIN, SystemRole.VIEWER, true],
  [SystemRole.ADMIN, SystemRole.SUPER_ADMIN, false],
  [SystemRole.ADMIN, SystemRole.ADMIN, false],
  [SystemRole.ADMIN, SystemRole.VIEWER, true],
  [SystemRole.VIEWER, SystemRole.SUPER_ADMIN, false],
  [SystemRole.VIEWER, SystemRole.ADMIN, false],
  [SystemRole.VIEWER, SystemRole.VIEWER, false],
];

describe('system-users.policy', () => {
  describe('canPatch — §5.1 matrix, profile-only patch, distinct target', () => {
    it.each(PATCH_PROFILE_MATRIX)(
      'actor %s patching a %s target → allowed=%s',
      (actorRole, targetRole, allowed) => {
        expect(
          canPatch(actor(actorRole), target(targetRole), PROFILE_ONLY).allowed,
        ).toBe(allowed);
      },
    );

    it('an ADMIN patching a non-VIEWER target is denied with the ADMIN-scope reason (AC-43)', () => {
      for (const targetRole of [SystemRole.SUPER_ADMIN, SystemRole.ADMIN]) {
        expect(
          canPatch(actor(SystemRole.ADMIN), target(targetRole), PROFILE_ONLY),
        ).toEqual({
          allowed: false,
          reason: ADMIN_MAY_ONLY_MODIFY_VIEWER,
        });
      }
    });

    it('VIEWER is denied even though RolesGuard already rejected them (defence in depth)', () => {
      expect(
        canPatch(
          actor(SystemRole.VIEWER),
          target(SystemRole.VIEWER),
          PROFILE_ONLY,
        ),
      ).toEqual({
        allowed: false,
        reason: INSUFFICIENT_ROLE,
      });
    });
  });

  describe('canPatch — `role` is SUPER_ADMIN-write-only, denied on KEY PRESENCE (§6.2, AC-44)', () => {
    // Every valid enum value, every target role — including the "harmless no-op".
    const nonSuperAdmins = [SystemRole.ADMIN, SystemRole.VIEWER] as const;

    for (const actorRole of nonSuperAdmins) {
      for (const targetRole of ROLES) {
        for (const value of ROLES) {
          it(`${actorRole} sending role="${value}" to a ${targetRole} target → 403`, () => {
            expect(
              canPatch(actor(actorRole), target(targetRole), { role: value }),
            ).toEqual({
              allowed: false,
              reason: ONLY_SUPER_ADMIN_MAY_CHANGE_ROLE,
            });
          });
        }
      }
    }

    it('specifically: an ADMIN sending a no-op role="VIEWER" to a VIEWER target → 403 (AC-44)', () => {
      expect(
        canPatch(actor(SystemRole.ADMIN), target(SystemRole.VIEWER), {
          role: SystemRole.VIEWER,
        }).allowed,
      ).toBe(false);
    });

    it.each(ROLES)(
      'a SUPER_ADMIN may set role="%s" on another user',
      (value) => {
        expect(
          canPatch(actor(SystemRole.SUPER_ADMIN), target(SystemRole.VIEWER), {
            role: value,
          }),
        ).toEqual({ allowed: true });
      },
    );

    it('an absent `role` key is not a role write (undefined ≠ present)', () => {
      expect(
        canPatch(actor(SystemRole.ADMIN), target(SystemRole.VIEWER), {
          role: undefined,
        }).allowed,
      ).toBe(true);
    });
  });

  describe('canPatch — `isActive`', () => {
    it('an ADMIN may toggle isActive on a VIEWER target', () => {
      expect(
        canPatch(actor(SystemRole.ADMIN), target(SystemRole.VIEWER), {
          isActive: false,
        }).allowed,
      ).toBe(true);
    });

    it.each([SystemRole.SUPER_ADMIN, SystemRole.ADMIN])(
      'an ADMIN may NOT toggle isActive on a %s target',
      (targetRole) => {
        expect(
          canPatch(actor(SystemRole.ADMIN), target(targetRole), {
            isActive: false,
          }).allowed,
        ).toBe(false);
      },
    );

    it('a SUPER_ADMIN may toggle isActive on any other target', () => {
      for (const targetRole of ROLES) {
        expect(
          canPatch(actor(SystemRole.SUPER_ADMIN), target(targetRole), {
            isActive: false,
          }).allowed,
        ).toBe(true);
      }
    });
  });

  describe('canPatch — §6.3 self-mutation rules bind EVERY role, and are evaluated first', () => {
    const SELF = 'same-id';

    it.each(ROLES)('%s patching their own role → 403 (AC-46)', (role) => {
      for (const value of ROLES) {
        expect(
          canPatch(actor(role, SELF), target(role, SELF), { role: value }),
        ).toEqual({
          allowed: false,
          reason: CANNOT_CHANGE_OWN_ROLE,
        });
      }
    });

    it.each(ROLES)(
      '%s patching their own isActive (true or false) → 403 (AC-47)',
      (role) => {
        for (const value of [true, false]) {
          expect(
            canPatch(actor(role, SELF), target(role, SELF), {
              isActive: value,
            }),
          ).toEqual({
            allowed: false,
            reason: CANNOT_CHANGE_OWN_ACTIVE_STATUS,
          });
        }
      },
    );

    it('the self-role rule fires before the matrix — a SUPER_ADMIN is not exempt', () => {
      expect(
        canPatch(
          actor(SystemRole.SUPER_ADMIN, SELF),
          target(SystemRole.SUPER_ADMIN, SELF),
          {
            role: SystemRole.ADMIN,
          },
        ),
      ).toEqual({ allowed: false, reason: CANNOT_CHANGE_OWN_ROLE });
    });

    it('role is checked before isActive when both are present on self', () => {
      expect(
        canPatch(
          actor(SystemRole.SUPER_ADMIN, SELF),
          target(SystemRole.SUPER_ADMIN, SELF),
          {
            role: SystemRole.VIEWER,
            isActive: false,
          },
        ),
      ).toEqual({ allowed: false, reason: CANNOT_CHANGE_OWN_ROLE });
    });

    it('a SUPER_ADMIN MAY patch their own profile-only fields (AC-49)', () => {
      expect(
        canPatch(
          actor(SystemRole.SUPER_ADMIN, SELF),
          target(SystemRole.SUPER_ADMIN, SELF),
          PROFILE_ONLY,
        ),
      ).toEqual({ allowed: true });
    });

    // INVERTED on 2026-07-26 (SELF-PROFILE-2, 02_design_log.md §1.8). This test previously asserted
    // `{ allowed: false, reason: ADMIN_MAY_ONLY_MODIFY_VIEWER }` under the name "an ADMIN may NOT
    // patch their own profile — their target is an ADMIN (SELF-PROFILE-1)". That 403 was collateral:
    // the ADMIN rule exists to stop ADMIN -> ADMIN LATERAL edits, and catching the actor's own row
    // was never its purpose. The PO approved the exception, which also removes an asymmetry with
    // SUPER_ADMIN (whose self-patch has always been allowed — see the test directly above).
    it('an ADMIN MAY patch their own profile-only fields (T1, SELF-PROFILE-2)', () => {
      expect(
        canPatch(
          actor(SystemRole.ADMIN, SELF),
          target(SystemRole.ADMIN, SELF),
          PROFILE_ONLY,
        ),
      ).toEqual({ allowed: true });
    });

    it('T2 — an ADMIN patching their OWN role is still 403, for every enum value', () => {
      for (const value of ROLES) {
        expect(
          canPatch(
            actor(SystemRole.ADMIN, SELF),
            target(SystemRole.ADMIN, SELF),
            {
              role: value,
            },
          ),
        ).toEqual({ allowed: false, reason: CANNOT_CHANGE_OWN_ROLE });
      }
    });

    it('T3 — an ADMIN patching their OWN isActive is still 403, true or false', () => {
      for (const value of [true, false]) {
        expect(
          canPatch(
            actor(SystemRole.ADMIN, SELF),
            target(SystemRole.ADMIN, SELF),
            {
              isActive: value,
            },
          ),
        ).toEqual({
          allowed: false,
          reason: CANNOT_CHANGE_OWN_ACTIVE_STATUS,
        });
      }
    });

    it('T9 — role is checked before isActive on an ADMIN self-patch carrying both (step 5 ordering)', () => {
      // Pins that the exception did NOT move the self-mutation rules: step 5 still returns first,
      // so step 6's new disjunct is unreachable for a patch carrying either key, and the reason
      // string the frontend/e2e assert on is unchanged.
      expect(
        canPatch(
          actor(SystemRole.ADMIN, SELF),
          target(SystemRole.ADMIN, SELF),
          {
            role: SystemRole.SUPER_ADMIN,
            isActive: false,
          },
        ),
      ).toEqual({ allowed: false, reason: CANNOT_CHANGE_OWN_ROLE });
    });

    // ─── THE invariant a future refactor is most likely to break: no ADMIN -> ADMIN widening ───

    it('T4 — an ADMIN may NOT patch a DIFFERENT ADMIN: the disjunct is id equality, not role equality', () => {
      expect(
        canPatch(
          actor(SystemRole.ADMIN, 'a'),
          target(SystemRole.ADMIN, 'b'),
          PROFILE_ONLY,
        ),
      ).toEqual({ allowed: false, reason: ADMIN_MAY_ONLY_MODIFY_VIEWER });
    });

    it('T5 — an ADMIN may NOT patch a SUPER_ADMIN, self-exception or not', () => {
      expect(
        canPatch(
          actor(SystemRole.ADMIN, 'a'),
          target(SystemRole.SUPER_ADMIN, 'b'),
          PROFILE_ONLY,
        ),
      ).toEqual({ allowed: false, reason: ADMIN_MAY_ONLY_MODIFY_VIEWER });
    });

    it('T6 — regression: an ADMIN may still patch a VIEWER target, isActive included', () => {
      for (const patch of [PROFILE_ONLY, { isActive: false }]) {
        expect(
          canPatch(
            actor(SystemRole.ADMIN, 'a'),
            target(SystemRole.VIEWER, 'b'),
            patch,
          ),
        ).toEqual({ allowed: true });
      }
    });

    it('T7 — regression: a SUPER_ADMIN self-patch is unchanged by the ADMIN exception', () => {
      expect(
        canPatch(
          actor(SystemRole.SUPER_ADMIN, SELF),
          target(SystemRole.SUPER_ADMIN, SELF),
          PROFILE_ONLY,
        ),
      ).toEqual({ allowed: true });
    });

    it('T8 — a VIEWER actor on their OWN id is still INSUFFICIENT_ROLE (the default: arm keeps its net)', () => {
      // The whole reason the exception is scoped INSIDE `case ADMIN` rather than hoisted above the
      // switch. If it were hoisted, a future @Roles(...) widening to VIEWER would silently grant
      // VIEWER self-assignment of departmentId/personnelRoleId, and the defence-in-depth arm that
      // exists to catch that widening would never run.
      expect(
        canPatch(
          actor(SystemRole.VIEWER, SELF),
          target(SystemRole.VIEWER, SELF),
          PROFILE_ONLY,
        ),
      ).toEqual({ allowed: false, reason: INSUFFICIENT_ROLE });
    });

    it('"own row" means equal ids — a same-role different-id target is not self', () => {
      expect(
        canPatch(
          actor(SystemRole.SUPER_ADMIN, 'a'),
          target(SystemRole.SUPER_ADMIN, 'b'),
          {
            role: SystemRole.VIEWER,
          },
        ),
      ).toEqual({ allowed: true });
    });
  });

  describe('canDelete', () => {
    it.each(ROLES)('%s deleting their own id → 403 (AC-48)', (role) => {
      expect(canDelete(actor(role, 'self'), target(role, 'self'))).toEqual({
        allowed: false,
        reason: CANNOT_DELETE_OWN_ACCOUNT,
      });
    });

    it('the self rule fires before the role check — a VIEWER self-delete is the self reason', () => {
      expect(
        canDelete(
          actor(SystemRole.VIEWER, 'self'),
          target(SystemRole.VIEWER, 'self'),
        ).allowed,
      ).toBe(false);
    });

    it.each(ROLES)('a SUPER_ADMIN may delete another %s', (targetRole) => {
      expect(
        canDelete(actor(SystemRole.SUPER_ADMIN), target(targetRole)),
      ).toEqual({
        allowed: true,
      });
    });

    it.each([SystemRole.ADMIN, SystemRole.VIEWER])(
      '%s may not delete anyone (unreachable — @Roles(SUPER_ADMIN) fires first)',
      (actorRole) => {
        expect(canDelete(actor(actorRole), target(SystemRole.VIEWER))).toEqual({
          allowed: false,
          reason: ONLY_SUPER_ADMIN_MAY_DELETE,
        });
      },
    );
  });

  // ─────────────── mayUseSystemReservedOptions (02_design_log.md §3.3) ───────────────

  describe('mayUseSystemReservedOptions', () => {
    it('AC-B13 — a SUPER_ADMIN may see and assign system-reserved options', () => {
      expect(mayUseSystemReservedOptions(actor(SystemRole.SUPER_ADMIN))).toBe(
        true,
      );
    });

    it.each([SystemRole.ADMIN, SystemRole.VIEWER])(
      'AC-B13 — %s may not',
      (actorRole) => {
        expect(mayUseSystemReservedOptions(actor(actorRole))).toBe(false);
      },
    );

    it('AC-B13 — returns a raw boolean, never a PolicyResult', () => {
      // Its callers ask "may I?" to build a WHERE clause, not "reject with what reason?". A denied
      // actor gets the SAME 400/404 as for a nonexistent option — never a 403 carrying a reason —
      // so a `reason` field would be dead weight and an invitation to surface the oracle.
      expect(typeof mayUseSystemReservedOptions(actor(SystemRole.ADMIN))).toBe(
        'boolean',
      );
    });

    it('AC-B13 — depends ONLY on the role, never on the actor id', () => {
      // Pure, per this file's charter: no I/O, no target, no row.
      expect(
        mayUseSystemReservedOptions({ id: 'a', role: SystemRole.SUPER_ADMIN }),
      ).toBe(
        mayUseSystemReservedOptions({ id: 'b', role: SystemRole.SUPER_ADMIN }),
      );
    });
  });
});
