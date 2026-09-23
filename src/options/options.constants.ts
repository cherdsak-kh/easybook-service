/**
 * The TOMBSTONE option rows — where the holders of a deleted option are re-pointed
 * (OPT-FALLBACK-1).
 *
 * They live in `src/` and not beside the other reserved names in `scripts/create-super-admin.ts`
 * because BOTH sides need them: the script creates them, and `OptionsService.softDelete` resolves
 * them BY NAME on every delete. Two literals would mean the delete silently fails to find a row
 * the seed definitely created.
 *
 * (Resolving by name here is a `WHERE name = $1` lookup, NOT an authorization expression. No name
 * comparison decides privilege anywhere in this codebase; `isSystemReserved` is the flag that makes
 * these rows unassignable, and `SystemUser.role` is the only thing that grants anything.)
 */
export const TOMBSTONE_DEPARTMENT_NAME = 'ไม่พบกลุ่ม/ฝ่าย';
export const TOMBSTONE_PERSONNEL_ROLE_NAME = 'ไม่พบตำแหน่ง';

/**
 * Raised when a delete cannot find its tombstone row — i.e. the database was migrated but never
 * seeded.
 *
 * It is a 500 and not a 400 by design: the caller did nothing wrong, the deployment is incomplete,
 * and the alternative (deleting anyway) would leave live rows pointing at a soft-deleted option
 * with no way to tell which ones they were.
 */
export const TOMBSTONE_ROW_MISSING =
  'The fallback option row is missing. Run the SUPER_ADMIN bootstrap before deleting options.';
