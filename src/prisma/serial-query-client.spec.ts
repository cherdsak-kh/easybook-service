/**
 * Spec for `SerialQueryClient` — the FIFO chain that keeps Prisma's concurrent relation loads from
 * overlapping on one transaction connection (see the class comment).
 *
 * ⚠️ NO DATABASE IS TOUCHED. The client is never connected: `Client.prototype.query` — what
 * `super.query` resolves to — is replaced by a spy that hands back promises the test settles by
 * hand, so "was query B sent to pg before query A settled" is a plain call count.
 */
import { Client } from 'pg';
import { SerialQueryClient } from './serial-query-client';

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const deferred = (): Deferred => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Runs every pending promise continuation. */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('SerialQueryClient', () => {
  let pgQuery: jest.SpyInstance;
  let pending: Deferred[];
  let client: SerialQueryClient;

  beforeEach(() => {
    pending = [];
    pgQuery = jest.spyOn(Client.prototype, 'query').mockImplementation(() => {
      const d = deferred();
      pending.push(d);
      return d.promise as never;
    });
    client = new SerialQueryClient({
      connectionString: 'postgresql://unit:unit@127.0.0.1:1/unit',
    });
  });

  afterEach(() => pgQuery.mockRestore());

  it('is a pg Client, so pg-pool can build and manage it', () => {
    expect(client).toBeInstanceOf(Client);
  });

  it('never sends a promise-form query while an earlier one is still in flight', async () => {
    const a = client.query('SELECT 1') as Promise<unknown>;
    const b = client.query('SELECT 2') as Promise<unknown>;
    const c = client.query('SELECT 3') as Promise<unknown>;

    await flush();
    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(pgQuery).toHaveBeenLastCalledWith('SELECT 1');

    pending[0].resolve('ra');
    await flush();
    expect(pgQuery).toHaveBeenCalledTimes(2);
    expect(pgQuery).toHaveBeenLastCalledWith('SELECT 2');

    pending[1].resolve('rb');
    await flush();
    expect(pgQuery).toHaveBeenCalledTimes(3);
    expect(pgQuery).toHaveBeenLastCalledWith('SELECT 3');

    pending[2].resolve('rc');
    // Each caller gets its OWN result, in order.
    await expect(Promise.all([a, b, c])).resolves.toEqual(['ra', 'rb', 'rc']);
  });

  it('a rejected query reaches its own caller and does not stall the ones behind it', async () => {
    const boom = new Error('duplicate key');
    const a = client.query('INSERT INTO t VALUES (1)') as Promise<unknown>;
    const b = client.query('SELECT 2') as Promise<unknown>;

    await flush();
    pending[0].reject(boom);
    await expect(a).rejects.toBe(boom);

    await flush();
    expect(pgQuery).toHaveBeenCalledTimes(2);
    pending[1].resolve('rb');
    await expect(b).resolves.toBe('rb');
  });

  it('forwards the exact arguments the adapter passed (config object + values)', async () => {
    const config = { text: 'SELECT $1', values: [7], rowMode: 'array' };
    const q = client.query(config, [7]) as Promise<unknown>;

    await flush();
    expect(pgQuery).toHaveBeenCalledWith(config, [7]);
    pending[0].resolve('r');
    await expect(q).resolves.toBe('r');
  });

  it('passes the callback form straight through, synchronously (the pg-pool pool.query path)', () => {
    const cb = jest.fn();
    client.query('SELECT 1', [], cb);
    client.query('SELECT 2', cb);

    // No await: both reached pg in the same tick, untouched by the chain.
    expect(pgQuery).toHaveBeenCalledTimes(2);
    expect(pgQuery).toHaveBeenNthCalledWith(1, 'SELECT 1', [], cb);
    expect(pgQuery).toHaveBeenNthCalledWith(2, 'SELECT 2', cb);
  });

  it('passes a Submittable straight through and returns what pg returns', () => {
    const submittable = { submit: jest.fn() };
    pgQuery.mockReturnValueOnce(submittable);

    expect(client.query(submittable)).toBe(submittable);
    expect(pgQuery).toHaveBeenCalledWith(submittable);
  });
});
