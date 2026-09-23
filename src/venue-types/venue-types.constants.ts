/**
 * The TOMBSTONE row for `VenueType` — where the venues of a deleted category are re-pointed.
 *
 * Lives in `src/` rather than beside the seed script because BOTH sides need it: the script creates
 * the row, and `VenueTypesService.softDelete` resolves it BY NAME on every delete. Two literals
 * would mean the delete silently fails to find a row the seed definitely created.
 *
 * (Resolving by name is a `WHERE name = $1` lookup, NOT an authorization expression. No name
 * comparison decides privilege anywhere in this codebase; `isSystemReserved` is the flag that makes
 * the row unassignable, and `SystemUser.role` is the only thing that grants anything.)
 */
export const TOMBSTONE_VENUE_TYPE_NAME = 'ไม่พบประเภทสถานที่';

/**
 * Raised when a delete cannot find the tombstone row — i.e. the database was migrated but never
 * seeded.
 *
 * ⚠️ A SEPARATE CONSTANT FROM `options.constants.ts`'s, and the difference is the sentence that
 * tells an operator what to do. That one says "run the SUPER_ADMIN bootstrap", which is true for the
 * two personnel tables (`create-super-admin.ts` owns their reserved rows) and WRONG here: this
 * table's reserved row is written by `venue-types:seed` (`Q16`, answered 2026-08-25). Reusing the
 * message would send whoever hits this to a command that cannot fix it.
 *
 * A 500 and not a 400, exactly as for the option tables: the caller did nothing wrong, the
 * deployment is incomplete, and deleting anyway would leave live venues pointing at a soft-deleted
 * category with no record of which ones they were.
 */
export const VENUE_TYPE_TOMBSTONE_ROW_MISSING =
  'The fallback venue type row is missing. Run `npm run venue-types:seed` before deleting venue types.';

/**
 * The five categories a fresh install starts with, and the ONE fact in this file that is not a
 * mechanism.
 *
 * ⚠️ THEY ARE DERIVED, NOT CHOSEN. `project-documents/markdown/บทที่ 1.md` §1.3.2 lists the nine
 * venues surveyed at โรงเรียนเทศบาลท่าโขลง 1, and these are the five groups those nine fall into:
 * โรงยิม (3) · ลานกิจกรรม (2) · สนามกีฬา (1) · ห้องประชุม (1) · หอประชุม (2) = 9. An earlier,
 * invented taxonomy — ห้องเรียน · ห้องปฏิบัติการ · ห้องคอมพิวเตอร์ · โรงอาหาร — matched not one of
 * the nine, and four of its categories would have been permanently empty. A category table is a
 * projection of the things it categorises; inventing one before reading the list produces something
 * that only looks like a design.
 *
 * ⚠️ A SEED, NOT A VALIDATION SET. Nothing checks against this list after the first run. The table
 * is operator-curated, which is the whole reason it is a table and not a Prisma enum.
 *
 * Order is Thai collation (`localeCompare(_, 'th')`), matching the prototype's own — nothing depends
 * on it, since the API sorts by name, but it keeps the two diffable by eye.
 */
export const STARTING_VENUE_TYPE_NAMES: readonly string[] = [
  'โรงยิม',
  'ลานกิจกรรม',
  'สนามกีฬา',
  'ห้องประชุม',
  'หอประชุม',
];
