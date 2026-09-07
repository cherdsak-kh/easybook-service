/**
 * Spec for `scripts/sanitize-thai-backfill.ts` — its argument guard and its write PLAN.
 *
 * WHY IT LIVES HERE AND NOT NEXT TO THE SCRIPT: the root jest config pins `rootDir: src`, so a spec
 * under `scripts/` is never discovered — the same reason `sweep-orphan-photos.script.spec.ts` sits in
 * `src/storage/` and `hash-password.script.spec.ts` in `src/auth/`. This one belongs to
 * `src/common/`, next to the sanitiser it re-runs.
 *
 * ⚠️ NO DATABASE IS TOUCHED. `planChanges` is pure by construction, which is the entire reason the
 * collision rule was factored out of `main` — the rule that must not regress is "a row whose new name
 * would duplicate an ACTIVE row is dropped from the plan BEFORE the first write", and a spec that
 * needed Postgres to assert it would be skipped in CI and rot.
 */
import {
  parseArgs,
  planChanges,
  type RowValue,
} from '../../scripts/sanitize-thai-backfill';

/** Builds a string from code points, so no case depends on how this file was saved. */
const cp = (...points: number[]): string => String.fromCodePoint(...points);

const SARA_E = 0x0e40; // เ
const SARA_AE = 0x0e41; // แ
const KO_KAI = 0x0e01; // ก
const NGO_NGU = 0x0e07; // ง
const ZWSP = 0x200b;

/** `แก` typed as SARA E twice — malformed, renders identically to the row below. */
const MALFORMED = cp(SARA_E, SARA_E, KO_KAI);
/** The same word, stored correctly. */
const CANONICAL = cp(SARA_AE, KO_KAI);

const row = (
  id: RowValue['id'],
  value: string,
  deletedAt: Date | null = null,
): RowValue => ({ id, value, deletedAt });

describe('scripts/sanitize-thai-backfill · parseArgs', () => {
  it('defaults to a LIVE run when given nothing', () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
  });

  it('reads --dry-run', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  it('tolerates --dry-run repeated', () => {
    expect(parseArgs(['--dry-run', '--dry-run'])).toEqual({ dryRun: true });
  });

  it.each(['--dryrun', '--dry_run', '--dry run', '-d', '--DRY-RUN', 'dry-run'])(
    'refuses %s instead of ignoring it',
    (arg) => {
      // A silently-ignored near-miss means the operator asked for a rehearsal and got a live
      // rewrite of nine columns. Throwing on the typo is what keeps that mistake cheap.
      expect(() => parseArgs([arg])).toThrow(/Unknown argument/);
    },
  );

  it('refuses an unknown argument even when a valid one is also present', () => {
    expect(() => parseArgs(['--dry-run', '--force'])).toThrow(
      /Unknown argument "--force"/,
    );
    expect(() => parseArgs(['--hours=24'])).toThrow(/Unknown argument/);
  });
});

describe('scripts/sanitize-thai-backfill · planChanges', () => {
  it('plans nothing for rows that are already canonical', () => {
    const plan = planChanges([row(1, CANONICAL), row(2, 'Hall A')], true);
    expect(plan).toEqual({ changes: [], collisions: [] });
  });

  it('plans the rows that differ, carrying before and after', () => {
    const plan = planChanges([row(1, MALFORMED), row(2, 'Hall A')], true);
    expect(plan.collisions).toEqual([]);
    expect(plan.changes).toEqual([
      { id: 1, before: MALFORMED, after: CANONICAL },
    ]);
  });

  it('also repairs invisible damage — a zero-width space is a change with no visible diff', () => {
    const plan = planChanges([row(1, cp(KO_KAI, ZWSP, NGO_NGU))], false);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].after).toBe(cp(KO_KAI, NGO_NGU));
  });

  it('includes SOFT-DELETED rows in the plan', () => {
    // A soft-deleted option still resolves its name on every existing assignment, and a
    // soft-deleted SystemUser can be restored. Skipping them would leave the damage in place.
    const plan = planChanges([row(1, MALFORMED, new Date())], true);
    expect(plan.changes).toEqual([
      { id: 1, before: MALFORMED, after: CANONICAL },
    ]);
  });

  describe('the partial unique index (`… ON (name) WHERE "deletedAt" IS NULL`)', () => {
    it('DROPS a change that would duplicate an existing ACTIVE row, and names the conflict', () => {
      // Row 2 already holds the canonical spelling. Writing row 1 would be a P2002 — mid-loop,
      // after some rows had already been written. It is refused up front instead.
      const plan = planChanges([row(1, MALFORMED), row(2, CANONICAL)], true);
      expect(plan.changes).toEqual([]);
      expect(plan.collisions).toEqual([
        {
          id: 1,
          before: MALFORMED,
          after: CANONICAL,
          conflictsWith: [2],
        },
      ]);
    });

    it('drops BOTH rows when two malformed actives converge on one name', () => {
      const otherMalformed = cp(SARA_E, SARA_E, KO_KAI, ZWSP);
      const plan = planChanges(
        [row(1, MALFORMED), row(2, otherMalformed)],
        true,
      );
      expect(plan.changes).toEqual([]);
      expect(plan.collisions.map((c) => c.id)).toEqual([1, 2]);
      expect(plan.collisions[0].conflictsWith).toEqual([2]);
      expect(plan.collisions[1].conflictsWith).toEqual([1]);
    });

    it('does NOT collide with a SOFT-DELETED row of the same name — the index is partial', () => {
      const plan = planChanges(
        [row(1, MALFORMED), row(2, CANONICAL, new Date())],
        true,
      );
      expect(plan.collisions).toEqual([]);
      expect(plan.changes.map((c) => c.id)).toEqual([1]);
    });

    it('leaves the already-correct member of a colliding pair completely alone', () => {
      const plan = planChanges([row(1, MALFORMED), row(2, CANONICAL)], true);
      // Row 2 needs no write, so it is neither a change nor a collision — only the row that would
      // have MOVED is refused.
      expect([...plan.changes, ...plan.collisions].map((c) => c.id)).toEqual([
        1,
      ]);
    });
  });

  describe('columns with no unique index (the four person-name columns)', () => {
    it('lets two people end up with the same first name', () => {
      const plan = planChanges(
        [row('u1', MALFORMED), row('u2', CANONICAL)],
        false,
      );
      expect(plan.collisions).toEqual([]);
      expect(plan.changes).toEqual([
        { id: 'u1', before: MALFORMED, after: CANONICAL },
      ]);
    });

    it('lets two malformed rows converge on one name', () => {
      const plan = planChanges(
        [row('u1', MALFORMED), row('u2', cp(SARA_E, SARA_E, KO_KAI, ZWSP))],
        false,
      );
      expect(plan.collisions).toEqual([]);
      expect(plan.changes.map((c) => c.id)).toEqual(['u1', 'u2']);
    });
  });

  it('is idempotent — re-planning the result of a run yields nothing to do', () => {
    const first = planChanges([row(1, MALFORMED), row(2, 'Hall A')], true);
    const applied = [row(1, first.changes[0].after), row(2, 'Hall A')];
    expect(planChanges(applied, true)).toEqual({ changes: [], collisions: [] });
  });
});
