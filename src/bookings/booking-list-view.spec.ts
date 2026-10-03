import { effectiveDepartmentIdOf } from './booking-list-view';

/**
 * `effectiveDepartmentIdOf` — the id-level twin of `requesterOf()` (Reports Phase 2, design §2.3.1).
 * One case per branch.
 */
describe('effectiveDepartmentIdOf', () => {
  it('the registration wins when one exists', () => {
    expect(
      effectiveDepartmentIdOf({
        departmentId: 9,
        lineUser: { registration: { departmentId: 3 } },
      }),
    ).toBe(3);
  });

  it('falls back to the override when there is no registration', () => {
    expect(
      effectiveDepartmentIdOf({
        departmentId: 9,
        lineUser: { registration: null },
      }),
    ).toBe(9);
  });

  it('falls back to the override when lineUser is null (a staff direct booking)', () => {
    expect(effectiveDepartmentIdOf({ departmentId: 9, lineUser: null })).toBe(
      9,
    );
  });

  it('is null when neither a registration nor an override resolves', () => {
    expect(
      effectiveDepartmentIdOf({ departmentId: null, lineUser: null }),
    ).toBeNull();
    expect(
      effectiveDepartmentIdOf({
        departmentId: null,
        lineUser: { registration: null },
      }),
    ).toBeNull();
  });
});
