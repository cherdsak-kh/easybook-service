/**
 * Thai text backfill — run: `npm run sanitize:thai-backfill [-- --dry-run]`
 *
 * `sanitizeThaiText` (`src/common/sanitize-thai.util.ts`) normalises Thai on the way IN, at the
 * transport boundary. Rows written BEFORE that transform existed were never put through it, so they
 * may still hold double SARA E (`เเ` where `แ` belongs), a tone mark typed before its vowel, a
 * NIKHAHIT+SARA AA pair, a zero-width space or an NBSP. Every one of those renders IDENTICALLY to
 * the correct spelling, so the row looks right in every list and is then unfindable by its own name.
 * This script re-runs the exact same function over the columns that already sanitise on write.
 *
 * ⚠️ RUN `-- --dry-run` FIRST. That is where the before/after values are printed; a live run logs
 * ids only (see PII below).
 *
 * ── THE NINE COLUMNS, AND WHY ONLY THESE ────────────────────────────────────────────────────────
 * `Department.name`, `PersonnelRole.name`, `VenueType.name`, `Amenity.name`, `Venue.name`,
 * `SystemUser.firstName`/`lastName`, `LineUserRegistration.firstName`/`lastName`.
 *
 * These are exactly the columns whose DTOs carry `@Transform(sanitizeThaiText)` today. Deliberately
 * ABSENT: `Venue.location`, `Venue.description`, `Venue.closedReason`, `BookingRequest.purpose`,
 * every phone column and every URL column. Backfilling a column whose WRITE path does not sanitise
 * would be undone by the next edit of that row, so it would be churn, not a fix — and rewriting a
 * URL's or a phone number's characters is a bug rather than a repair (same reasoning as the `trim`
 * that survives in `src/venues/dto/venue.dto.ts`). Widen the write path first, then this list.
 *
 * ── SOFT-DELETED ROWS ARE INCLUDED ──────────────────────────────────────────────────────────────
 * `deletedAt IS NOT NULL` rows are scanned and fixed like any other, on purpose:
 *   - a soft-deleted option still RESOLVES its name forever on existing assignments (the read/write
 *     asymmetry `CLAUDE.md` documents), so a malformed one is still on somebody's screen;
 *   - a soft-deleted `SystemUser` can be restored (`POST /system-users/:id/restore`), and a restore
 *     that brings back an unsearchable name has fixed nothing;
 *   - the partial unique indexes are `WHERE "deletedAt" IS NULL`, so a soft-deleted row can never be
 *     the row that collides. Including them is strictly free on the risk side.
 *
 * ── COLLISIONS: DETECTED BEFORE ANY WRITE, AND SKIPPED ───────────────────────────────────────────
 * Five of the nine columns carry a PARTIAL unique index (`departments_name_active_key`,
 * `personnel_roles_name_active_key`, `venue_types_name_active_key`, `amenities_name_active_key`,
 * `venues_name_active_key` — all `ON (name) WHERE "deletedAt" IS NULL`). Two ACTIVE rows whose
 * sanitised names are equal would violate it, and a naive row-by-row loop would discover that as a
 * P2002 in the middle of the run, leaving some rows written and some not.
 *
 * So the plan for every table is computed IN FULL BEFORE THE FIRST WRITE. Active rows are grouped by
 * their sanitised name; in any group of more than one, every row that WOULD CHANGE is dropped from
 * the plan, logged as a `COLLISION` warning naming the conflicting ids, and never written. Rows that
 * were already correct are left exactly as they are. The run then completes normally and exits 0
 * with `collisions=N` in the summary — a collision means two rows genuinely become the same name,
 * which is a human's rename decision, not something a backfill may guess at. Re-run after renaming
 * one of them and the pair resolves.
 *
 * ── PII ─────────────────────────────────────────────────────────────────────────────────────────
 * `SystemUser` and `LineUserRegistration` names are personal data. A LIVE run logs the id and the
 * column only — never a value, never a whole row. A DRY RUN prints `"<before>" -> "<after>"` for the
 * one field being changed, because an operator cannot approve a rewrite they cannot see; that output
 * therefore contains names and must not be pasted into a ticket or a chat.
 *
 * Exit codes: 0 on a completed run INCLUDING one that changed nothing and one that skipped
 * collisions; 1 on bad arguments and on a run where any row failed to write.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { sanitizeThaiText } from '../src/common/sanitize-thai.util';

const logger = new Logger('SanitizeThaiBackfill');

const USAGE = 'Usage: npm run sanitize:thai-backfill -- [--dry-run]';

export interface BackfillArgs {
  dryRun: boolean;
}

/**
 * Parse the argv tail. Exported for the unit spec.
 *
 * ⚠️ AN UNRECOGNISED ARGUMENT IS A HARD ERROR, exactly as in `parseSweepArgs`. A silently-ignored
 * `--dryrun` means the operator asked for a rehearsal and got a live rewrite of nine columns.
 */
export function parseArgs(args: readonly string[]): BackfillArgs {
  let dryRun = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument "${arg}". ${USAGE}`);
  }

  return { dryRun };
}

/** Int for the four curated vocabularies + `Amenity`; cuid for the three entity tables. */
export type RowId = string | number;

/** One column value as read out of the database. */
export interface RowValue {
  id: RowId;
  value: string;
  deletedAt: Date | null;
}

export interface Change {
  id: RowId;
  before: string;
  after: string;
}

export interface Collision extends Change {
  /** The other ACTIVE ids that end up holding this same name. */
  conflictsWith: RowId[];
}

export interface Plan {
  /** Rows that differ and are safe to write. */
  changes: Change[];
  /** Rows that differ but were dropped because writing them would break a partial unique index. */
  collisions: Collision[];
}

/**
 * Turn the rows of one column into a write plan. PURE — no Prisma, no I/O — which is what lets the
 * spec cover the collision rule without a database.
 *
 * `activeNameIsUnique` is the presence of a `… ON (name) WHERE "deletedAt" IS NULL` index on that
 * table. When false (the four person-name columns) every difference is a change, because nothing
 * constrains two people from sharing a first name.
 */
export function planChanges(
  rows: readonly RowValue[],
  activeNameIsUnique: boolean,
): Plan {
  const after = new Map<RowId, string>();
  for (const row of rows) {
    after.set(row.id, sanitizeThaiText({ value: row.value }) as string);
  }

  /**
   * Sanitised name → the ACTIVE ids that will hold it once the plan is applied. Soft-deleted rows
   * are excluded: the unique index is partial, so they cannot participate in a violation.
   */
  const activeIdsByFinalName = new Map<string, RowId[]>();
  if (activeNameIsUnique) {
    for (const row of rows) {
      if (row.deletedAt !== null) continue;
      const name = after.get(row.id)!;
      const bucket = activeIdsByFinalName.get(name);
      if (bucket) bucket.push(row.id);
      else activeIdsByFinalName.set(name, [row.id]);
    }
  }

  const changes: Change[] = [];
  const collisions: Collision[] = [];

  for (const row of rows) {
    const next = after.get(row.id)!;
    if (next === row.value) continue;

    const sharing = activeIdsByFinalName.get(next) ?? [];
    if (sharing.length > 1) {
      collisions.push({
        id: row.id,
        before: row.value,
        after: next,
        conflictsWith: sharing.filter((other) => other !== row.id),
      });
      continue;
    }

    changes.push({ id: row.id, before: row.value, after: next });
  }

  return { changes, collisions };
}

/** One scannable column, bound to a live client. */
interface ScanTarget {
  /** Log label, e.g. `Venue.name`. */
  label: string;
  /** Does an ACTIVE-rows-only unique index cover this column? */
  activeNameIsUnique: boolean;
  read: () => Promise<RowValue[]>;
  write: (id: RowId, value: string) => Promise<unknown>;
}

/**
 * The nine targets, spelled out one delegate at a time.
 *
 * ⚠️ NOT COLLAPSED INTO A LOOP OVER A DELEGATE ARRAY, and that is not laziness: a union of Prisma's
 * (heavily overloaded) delegate types is not callable in TypeScript — the same fact `OptionsService`
 * works around with its hand-written `OptionDelegate` and `test/e2e-app.ts` notes inline. Explicit
 * closures keep every `where` and every `data` type-checked.
 */
function buildTargets(prisma: PrismaClient): ScanTarget[] {
  return [
    {
      label: 'Department.name',
      activeNameIsUnique: true,
      read: async () =>
        (
          await prisma.department.findMany({
            select: { id: true, name: true, deletedAt: true },
          })
        ).map((r) => ({ id: r.id, value: r.name, deletedAt: r.deletedAt })),
      write: (id, value) =>
        prisma.department.update({
          where: { id: id as number },
          data: { name: value },
        }),
    },
    {
      label: 'PersonnelRole.name',
      activeNameIsUnique: true,
      read: async () =>
        (
          await prisma.personnelRole.findMany({
            select: { id: true, name: true, deletedAt: true },
          })
        ).map((r) => ({ id: r.id, value: r.name, deletedAt: r.deletedAt })),
      write: (id, value) =>
        prisma.personnelRole.update({
          where: { id: id as number },
          data: { name: value },
        }),
    },
    {
      label: 'VenueType.name',
      activeNameIsUnique: true,
      read: async () =>
        (
          await prisma.venueType.findMany({
            select: { id: true, name: true, deletedAt: true },
          })
        ).map((r) => ({ id: r.id, value: r.name, deletedAt: r.deletedAt })),
      write: (id, value) =>
        prisma.venueType.update({
          where: { id: id as number },
          data: { name: value },
        }),
    },
    {
      label: 'Amenity.name',
      activeNameIsUnique: true,
      read: async () =>
        (
          await prisma.amenity.findMany({
            select: { id: true, name: true, deletedAt: true },
          })
        ).map((r) => ({ id: r.id, value: r.name, deletedAt: r.deletedAt })),
      write: (id, value) =>
        prisma.amenity.update({
          where: { id: id as number },
          data: { name: value },
        }),
    },
    {
      label: 'Venue.name',
      activeNameIsUnique: true,
      read: async () =>
        (
          await prisma.venue.findMany({
            select: { id: true, name: true, deletedAt: true },
          })
        ).map((r) => ({ id: r.id, value: r.name, deletedAt: r.deletedAt })),
      write: (id, value) =>
        prisma.venue.update({
          where: { id: id as string },
          data: { name: value },
        }),
    },
    {
      label: 'SystemUser.firstName',
      activeNameIsUnique: false,
      read: async () =>
        (
          await prisma.systemUser.findMany({
            select: { id: true, firstName: true, deletedAt: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.firstName,
          deletedAt: r.deletedAt,
        })),
      write: (id, value) =>
        prisma.systemUser.update({
          where: { id: id as string },
          data: { firstName: value },
        }),
    },
    {
      label: 'SystemUser.lastName',
      activeNameIsUnique: false,
      read: async () =>
        (
          await prisma.systemUser.findMany({
            select: { id: true, lastName: true, deletedAt: true },
          })
        ).map((r) => ({ id: r.id, value: r.lastName, deletedAt: r.deletedAt })),
      write: (id, value) =>
        prisma.systemUser.update({
          where: { id: id as string },
          data: { lastName: value },
        }),
    },
    {
      label: 'LineUserRegistration.firstName',
      activeNameIsUnique: false,
      read: async () =>
        (
          await prisma.lineUserRegistration.findMany({
            select: { id: true, firstName: true, deletedAt: true },
          })
        ).map((r) => ({
          id: r.id,
          value: r.firstName,
          deletedAt: r.deletedAt,
        })),
      write: (id, value) =>
        prisma.lineUserRegistration.update({
          where: { id: id as string },
          data: { firstName: value },
        }),
    },
    {
      label: 'LineUserRegistration.lastName',
      activeNameIsUnique: false,
      read: async () =>
        (
          await prisma.lineUserRegistration.findMany({
            select: { id: true, lastName: true, deletedAt: true },
          })
        ).map((r) => ({ id: r.id, value: r.lastName, deletedAt: r.deletedAt })),
      write: (id, value) =>
        prisma.lineUserRegistration.update({
          where: { id: id as string },
          data: { lastName: value },
        }),
    },
  ];
}

/**
 * Exported for the unit spec's `require.main` guard check only — it opens a real connection, so the
 * spec never calls it. `process.exitCode` rather than `process.exit`, so the log lines flush (same
 * reason as `sweep-orphan-photos.ts`).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let args: BackfillArgs;
  try {
    args = parseArgs(argv);
  } catch (error: unknown) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  logger.log(
    `Scanning 9 Thai text columns${args.dryRun ? ' — DRY RUN, nothing will be written' : ''}.`,
  );

  let scanned = 0;
  let modified = 0;
  let collisions = 0;
  let failed = 0;

  try {
    for (const target of buildTargets(prisma)) {
      const rows = await target.read();
      scanned += rows.length;

      const plan = planChanges(rows, target.activeNameIsUnique);

      for (const clash of plan.collisions) {
        collisions += 1;
        logger.warn(
          `[${target.label}] COLLISION ${String(clash.id)}: sanitising would duplicate the name already ending up on active id(s) ${clash.conflictsWith.map(String).join(', ')}. NOT written — rename one of them by hand, then re-run.`,
        );
      }

      for (const change of plan.changes) {
        if (args.dryRun) {
          // Values printed only here: this is the rehearsal an operator has to be able to read.
          logger.log(
            `[${target.label}] ${String(change.id)}: "${change.before}" -> "${change.after}"`,
          );
          modified += 1;
          continue;
        }

        try {
          await target.write(change.id, change.after);
          modified += 1;
          // ⚠️ ID AND COLUMN ONLY. Four of these columns are personal data; the dry run is where the
          // values live.
          logger.log(`[${target.label}] ${String(change.id)}: normalised`);
        } catch (error: unknown) {
          failed += 1;
          logger.error(
            `[${target.label}] ${String(change.id)}: write failed — ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error: unknown) {
    logger.error(
      `Backfill failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  } finally {
    await prisma.$disconnect();
  }

  logger.log(
    `Backfill complete${args.dryRun ? ' (dry run — nothing was written)' : ''}. scanned=${scanned} modified=${modified} collisions=${collisions} failed=${failed} durationMs=${Date.now() - startedAt}`,
  );

  if (failed > 0) process.exitCode = 1;
}

// Guarded so the spec can import this module without the CLI firing on require.
if (require.main === module) {
  void main();
}
