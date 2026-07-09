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
