import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RealtimeActor } from '../realtime/realtime.constants';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { readBookingListDtos } from './booking-list-view';

/**
 * The booking queue's realtime fan-out (`ADMIN-REALTIME-BOOKINGS-1`, design constraint `Q4`).
 *
 * A pure function module rather than a provider — the same shape `booking-overlap.ts` and
 * `booking-code.ts` take, and for the same reason: both booking services need it, neither owns it,
 * and there is no instance for one caller to get a different version of.
 *
 * ── 🔴 THE TWO RULES THIS FILE EXISTS TO KEEP ──
 * 1. **Emit AFTER the commit, never inside the transaction.** Enforced by construction: the read
 *    below takes `PrismaService`, which a `Prisma.TransactionClient` is not assignable to.
 * 2. **One event per row that changed.** `ids` is a LIST because ADR-001 changes other people's
 *    rows: an approval writes the subject *and* every overlapping pending request it auto-rejects.
 *    Announcing only the subject leaves the losers stale on every other operator's screen, which is
 *    the exact defect this ticket was raised to fix.
 */
const logger = new Logger('BookingRealtime');

/**
 * Re-reads the named requests in the queue-row shape and broadcasts one event each.
 *
 * ── WHY IT RE-READS INSTEAD OF REUSING THE ROW IN HAND ──
 * The payload is `AdminBookingRequestListItemDto`, the shape the generated client is typed from, and
 * it is assembled from a specific `select` (nested requester, venue and every slot) that no writing
 * path holds. Hand-building something that merely resembles it would put a second, drifting producer
 * on the contract. One extra `findMany` per emit batch, off the critical path, buys a payload that is
 * the same object `GET /booking-requests` returns — see `readBookingListDtos`.
 *
 * ── FAIL-SOFT, exactly like `LineUserService.publish` ──
 * NEVER throws and never rejects: the write has already committed, so a fan-out failure (transport
 * down, gateway not yet initialised, a row deleted between the commit and the read) is logged at
 * `warn` and swallowed. It must not roll back or fail an HTTP mutation.
 *
 * ⚠️ PII DISCIPLINE: the log line carries the event kind and ids ONLY. `requesterName`, `contactPhone`
 * and `purpose` travel through this function and none of them may ever reach a log.
 */
export async function publishBookingRequests(
  prisma: PrismaService,
  realtime: RealtimeGateway,
  kind: 'created' | 'updated',
  ids: readonly string[],
  actor: RealtimeActor | null,
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const bookings = await readBookingListDtos(prisma, ids);
    // ⚠️ NARROWED EXPLICITLY. The admin actor also carries `role`, and a structural type does not
    // strip an extra property at runtime — passing it straight through would put the operator's role
    // on the wire, which is precisely what `RealtimeActor`'s doc comment says it does not carry.
    const who = actor ? { id: actor.id, name: actor.name } : null;
    for (const booking of bookings) {
      if (kind === 'created') realtime.emitBookingRequestCreated(booking, who);
      else realtime.emitBookingRequestUpdated(booking, who);
    }
  } catch (error) {
    logger.warn(
      `Realtime publish failed (write already committed). kind=${kind} ids=${ids.join(',')}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
