/**
 * Is anything SCHEDULED at all? — the ONE guard every cron registration in this app reads.
 *
 * ⚠️ THREE REGISTRATION SITES READ THIS ONE CONSTANT, and none may re-type the expression:
 * `AppModule` (`ScheduleModule.forRoot()`), `StorageModule` (`OrphanPhotoSweeperCron`) and
 * `BookingsModule` (`BookingExpiryCron`, #ISSUE-06). A copy in a fourth place is a copy that can
 * disagree.
 *
 * ⚠️ THE GUARD IS ON REGISTRATION, NOT ON THE HANDLER BODY, and the difference is the whole point.
 * `test/e2e-app.ts` boots the REAL `AppModule`, so an unconditional `ScheduleModule.forRoot()` would
 * create a live `CronJob` timer in every one of the e2e suites. An `if (test) return;` inside a
 * handler stops the WORK but not the TIMER: the handle stays open, jest reports "a worker process
 * has failed to exit gracefully", and the suite either hangs or is force-killed. Nothing may be
 * registered in the first place.
 *
 * ⚠️ TWO SIGNALS, DELIBERATELY. A bare `NODE_ENV` check FAILS OPEN — unset, `'Test'`, or a trailing
 * space all leave the timer live, and `validateEnv` never requires `NODE_ENV` (the same objection
 * `scripts/hash-password.ts` records against gating a route on it). Both were MEASURED rather than
 * assumed: under the unit config AND under `test/jest-e2e.json`, jest sets `NODE_ENV="test"` and
 * `JEST_WORKER_ID="1"`. Either one alone would do; together, a jest run that somehow carried a
 * different `NODE_ENV` still registers nothing.
 *
 * Note the direction of the failure: this gate failing open means a timer under test (loud — an open
 * handle), never a missing job in production (silent). That is the right way round.
 */

/** Pure, so the spec can test both branches without mutating `process.env`. */
export function schedulingEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== 'test' && env.JEST_WORKER_ID === undefined;
}

export const SCHEDULING_ENABLED = schedulingEnabled(process.env);
