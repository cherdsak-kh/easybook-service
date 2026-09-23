/**
 * Spec for `scripts/sweep-orphan-photos.ts`'s argument guard.
 *
 * WHY IT LIVES HERE AND NOT NEXT TO THE SCRIPT: the root jest config pins `rootDir: src`, so a spec
 * under `scripts/` is never discovered — the same reason `hash-password.script.spec.ts` sits in
 * `src/auth/`. This one belongs to `src/storage/`, next to the service it drives.
 *
 * ⚠️ WHAT IS BEING PROTECTED IS NOT ARGUMENT PARSING. `--hours` below 1 is the one input that turns a
 * cleanup job into data loss: a staged object is indistinguishable from one an open dialog is still
 * holding, so the age floor is the whole safety property. These cases exist so nobody "simplifies"
 * the clamp away later.
 */
import {
  DEFAULT_HOURS,
  MIN_HOURS,
  parseSweepArgs,
} from '../../scripts/sweep-orphan-photos';

describe('scripts/sweep-orphan-photos · parseSweepArgs', () => {
  it('defaults to a real 24h sweep when given nothing', () => {
    expect(parseSweepArgs([])).toEqual({ dryRun: false, hours: DEFAULT_HOURS });
    expect(DEFAULT_HOURS).toBe(24);
  });

  it('reads --dry-run and --hours together, in either order', () => {
    expect(parseSweepArgs(['--dry-run', '--hours=48'])).toEqual({
      dryRun: true,
      hours: 48,
    });
    expect(parseSweepArgs(['--hours=48', '--dry-run'])).toEqual({
      dryRun: true,
      hours: 48,
    });
  });

  it('accepts the floor itself', () => {
    expect(parseSweepArgs([`--hours=${MIN_HOURS}`]).hours).toBe(MIN_HOURS);
  });

  it.each(['--hours=0', '--hours=0.5', '--hours=-5'])(
    'refuses %s — below the floor is how a live dialog loses its photo',
    (arg) => {
      expect(() => parseSweepArgs([arg])).toThrow(/at least 1/);
    },
  );

  it.each(['--hours=abc', '--hours=', '--hours=  ', '--hours=NaN'])(
    'refuses %s as not a number',
    (arg) => {
      expect(() => parseSweepArgs([arg])).toThrow(/must be a number/);
    },
  );

  it('refuses an unknown argument instead of ignoring it', () => {
    // A silently-ignored `--dryrun` is a real deletion the operator did not ask for.
    expect(() => parseSweepArgs(['--dryrun'])).toThrow(/Unknown argument/);
    expect(() => parseSweepArgs(['--hours', '48'])).toThrow(/Unknown argument/);
  });
});
