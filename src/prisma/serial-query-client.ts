import { Client } from 'pg';

/**
 * A `pg` Client that never hands the driver a second query while one is still in flight on it.
 *
 * 🔴 WHY THIS EXISTS. Prisma 7 loads relations (`include` / nested `select`) as a `join` node whose
 * child queries it runs with `Promise.all` (`@prisma/client-engine-runtime`, query-interpreter.ts,
 * `case 'join'`). Outside a transaction each child goes through `pool.query()` and gets its own
 * connection. INSIDE one, every child lands on the transaction's single checked-out client — and
 * that covers our interactive `$transaction`s, the batch `$transaction([...])` list reads, and the
 * transaction Prisma opens BY ITSELF around a plain `update()` that returns relations. pg 8 parks
 * the extras in its internal queue and warns ("Calling client.query() when the client is already
 * executing a query is deprecated…"); pg 9 removes that queue. Upgrading Prisma does not help
 * (7.10.0 still does this), and passing an explicit `pg.Pool` does not either — pool size is
 * irrelevant when every query is on one client.
 *
 * The fix is the one the warning names — "an external async flow control mechanism": a FIFO
 * promise chain per client. Nothing changes on the wire: one Postgres connection runs one
 * statement at a time regardless, and pg's own queue was already FIFO, so this only moves the
 * waiting out of pg and in here. A rejected query does not stall the chain; the next one is sent
 * exactly as pg's queue would have sent it (inside a failed transaction Postgres then answers
 * `25P02`, same as before).
 *
 * ⚠️ Only the promise form is chained — the only form `@prisma/adapter-pg` uses on a transaction
 * client. The callback form passes straight through: pg-pool's own `pool.query()` uses it on a
 * client it checked out for that one query, so it cannot overlap anything. A Submittable
 * (`config.submit`, e.g. a cursor) also passes through — pg drives it by events, not a promise.
 */
export class SerialQueryClient extends Client {
  /** Settles once every promise-form query issued so far has settled. Never rejects. */
  private tail: Promise<void> = Promise.resolve();

  // `any`, not `unknown`: this must stay assignable to every overload of `Client#query`.
  query(...args: unknown[]): any {
    const [config, values, callback] = args;
    const forward = (): unknown =>
      (super.query as (...a: unknown[]) => unknown).apply(this, args);

    if (
      typeof values === 'function' ||
      typeof callback === 'function' ||
      typeof (config as { submit?: unknown } | null | undefined)?.submit ===
        'function'
    ) {
      return forward();
    }

    const result = this.tail.then(forward);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
