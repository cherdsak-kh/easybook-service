import { ConflictException, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CONCURRENT_MODIFICATION } from '../system-users/system-users.errors';

/**
 * SQLSTATEs that mean "this transaction lost a race and must be retried".
 *   40001 = serialization_failure  (Serializable Snapshot Isolation conflict)
 *   40P01 = deadlock_detected
 */
const WRITE_CONFLICT_SQLSTATES = new Set(['40001', '40P01']);

/**
 * True when `e` is a serialization failure / write conflict (DD-10).
 *
 * `@prisma/adapter-pg` maps SQLSTATE 40001 -> TransactionWriteConflict -> P2034, but it does
 * NOT map 40P01 (deadlock_detected): that falls through to `kind: 'postgres'`, the client emits
 * no Prisma error code, and it would surface as a 500 — exactly what AC-51 forbids. So we also
 * sniff the raw SQLSTATE anywhere in the error's `cause` chain.
 */
export function isWriteConflict(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
    return true;
  }
  for (
    let cur: unknown = e;
    cur != null;
    cur = (cur as { cause?: unknown }).cause
  ) {
    const c = cur as { code?: unknown; originalCode?: unknown };
    const code = typeof c.originalCode === 'string' ? c.originalCode : c.code;
    if (typeof code === 'string' && WRITE_CONFLICT_SQLSTATES.has(code)) {
      return true;
    }
  }
  return false;
}

/** SQLSTATE 55P03 = lock_not_available — what `FOR UPDATE NOWAIT` raises when the row is held. */
const LOCK_NOT_AVAILABLE_SQLSTATE = '55P03';
const LOCK_NOT_AVAILABLE_TEXT = 'could not obtain lock on row';

/** Bound on the error-chain walk below — errors can be cyclic, and the real chain is ~3 deep. */
const ERROR_CHAIN_MAX_NODES = 16;

/**
 * True when `e` is Postgres' `55P03` (`lock_not_available`) — a `FOR UPDATE NOWAIT` that found the
 * row locked by another transaction (`ANNOUNCE-API-2`, design S-4).
 *
 * 🔴 `isWriteConflict`'s walk does NOT find this, so it is its own function. Prisma 7 rethrows a
 * failed `$queryRaw` as `PrismaClientKnownRequestError` **`P2010`** ("Raw query failed. Code:
 * `55P03`. …") with the adapter's error under `meta.driverAdapterError`, whose `cause.originalCode`
 * is the SQLSTATE — a path neither `cause` nor `meta.cause` reaches. Because that shape is an adapter
 * detail, three independent nets:
 *
 * 1. `P2010` whose message names ``Code: `55P03` ``;
 * 2. any node on the chain (`cause`, `meta.cause`, `meta.driverAdapterError`, recursively) whose
 *    `originalCode ?? code` is `55P03`;
 * 3. any message on that chain containing Postgres' own text, "could not obtain lock on row".
 *
 * The e2e lock test (a real second `NOWAIT` against Postgres) is the proof; a unit test with a
 * hand-built error only proves the shape we guessed.
 */
export function isLockNotAvailable(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2010' &&
    e.message.includes(`Code: \`${LOCK_NOT_AVAILABLE_SQLSTATE}\``)
  ) {
    return true;
  }

  const seen = new Set<object>();
  const queue: unknown[] = [e];
  while (queue.length > 0 && seen.size < ERROR_CHAIN_MAX_NODES) {
    const cur = queue.shift();
    if (cur === null || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);

    const node = cur as {
      code?: unknown;
      originalCode?: unknown;
      message?: unknown;
      originalMessage?: unknown;
      cause?: unknown;
      meta?: unknown;
    };
    const code =
      typeof node.originalCode === 'string' ? node.originalCode : node.code;
    if (code === LOCK_NOT_AVAILABLE_SQLSTATE) return true;
    for (const text of [node.message, node.originalMessage]) {
      if (typeof text === 'string' && text.includes(LOCK_NOT_AVAILABLE_TEXT)) {
        return true;
      }
    }

    queue.push(node.cause);
    if (node.meta !== null && typeof node.meta === 'object') {
      const meta = node.meta as {
        cause?: unknown;
        driverAdapterError?: unknown;
      };
      queue.push(meta.cause, meta.driverAdapterError);
    }
  }
  return false;
}

/**
 * Rethrows an error raised inside a `$transaction`.
 *
 * - `HttpException`s (403 / 404 / 409) raised deliberately inside the tx pass straight through;
 *   throwing is what rolls the transaction back, so the status and the rollback are one event.
 * - A write conflict becomes `409`, never `500` and never a partial write (AC-51).
 * - Anything else is rethrown unchanged.
 */
export function mapTransactionError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  if (isWriteConflict(e)) throw new ConflictException(CONCURRENT_MODIFICATION);
  throw e;
}
