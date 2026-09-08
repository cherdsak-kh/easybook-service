import { Logger } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClientRealtimeGateway } from '../realtime/client-realtime.gateway';
import {
  CLIENT_REALTIME_EVENTS,
  type ClientBookingUpdatedPayload,
  type ClientVenueAvailabilityPayload,
  type RealtimeActor,
} from '../realtime/realtime.constants';
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
 * Re-reads the named requests and broadcasts them to **both** realtime audiences.
 *
 * ── 🔴 TWO NAMESPACES, TWO PAYLOADS, ONE DISPATCHER (`CLIENT-REALTIME-1`) ──
 * `/admin` gets the full queue row (`AdminBookingRequestListItemDto`) because every socket there
 * cleared the `SUPER_ADMIN|ADMIN` gate. `/client` gets three targeted, minimal events instead — see
 * {@link publishClientBookingUpdates} — because `D-C13` forbids putting request details on a channel
 * end-users share. They are NOT the same event with a different audience, and this is the one place
 * both are produced so a future emit site cannot serve one and forget the other.
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
  client: ClientRealtimeGateway,
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

  // ⚠️ ITS OWN try/catch, DELIBERATELY OUTSIDE THE ONE ABOVE. The two namespaces are independent
  // audiences: an admin-side failure must not silently cost a LINE user the toast that tells them
  // their request was refused, and vice versa. Both are fail-soft; neither can fail the HTTP write.
  await publishClientBookingUpdates(prisma, client, ids);
}

/**
 * ⛔ WHAT REACHES `/client` IS DECIDED BY STATUS, NEVER BY `kind` (`CLIENT-REALTIME-1`).
 *
 * `kind` answers an ADMIN question — "is this a new row in the queue, or one that moved?" — and the
 * client portal does not have a queue. What a LINE user reacts to is a change they can SEE: their
 * own card flipping, or a calendar cell recolouring under their cursor. A staff
 * `POST /booking-requests/direct` is born `APPROVED` and therefore `kind: 'created'`; gating on
 * `kind` would silently drop the busiest calendar write in the product.
 *
 * ── 🔴 WHY `PENDING` IS IN THIS LIST, AND WHY THAT IS NOT AN INCONSISTENCY WITH `#/home` ──
 * This list must agree with `OCCUPYING_STATUSES` in `bookings.service.ts`, which is
 * `[APPROVED, PENDING]`. A newly submitted pending request **occupies** the venue's calendar: the
 * availability read paints it, so a second user watching `#/venue/:id` must not be shown that hour as
 * free and allowed to submit for it. Announcing `APPROVED` but not `PENDING` here would leave the
 * occupancy rule and the fan-out rule disagreeing, and the competing user finds out only on refetch.
 *
 * ⛔ DO NOT "CLEAN THIS UP" AGAINST `#/home`. The org-wide schedule is `APPROVED`-only and stays so —
 * that screen is fed by {@link SCHEDULE_PULSE_STATUSES}, a DIFFERENT list, precisely because these
 * two audiences have different rules. A pending request is a fact about ONE ROOM'S availability and
 * is not a fact about the school's day.
 */
const CLIENT_ANNOUNCED_STATUSES: readonly BookingStatus[] = [
  BookingStatus.APPROVED,
  BookingStatus.REJECTED,
  BookingStatus.CANCELLED,
  BookingStatus.PENDING,
];

/**
 * 🔴 THE ONLY STATUSES THAT MAY PULSE `schedule:all`. A SEPARATE LIST FROM
 * {@link CLIENT_ANNOUNCED_STATUSES}, ON PURPOSE — it is the structural form of a privacy rule, not an
 * economy.
 *
 * `schedule:all` is the room EVERY connected end-user sits in, and `#/home` shows approved activities
 * only. Pulsing it for a `PENDING` submission would do two wrong things at once: tell the whole
 * organisation that an unapproved request exists (`D-C13`), and make every open client refetch a view
 * that cannot have changed. A `REJECTED` request never occupied the schedule either, so it says
 * nothing there.
 *
 * ⛔ ADDING A STATUS HERE IS A PRIVACY DECISION. Adding one to `CLIENT_ANNOUNCED_STATUSES` is not the
 * same act and must not silently become one — that is why widening the announced list cannot widen
 * this one.
 */
const SCHEDULE_PULSE_STATUSES: readonly BookingStatus[] = [
  BookingStatus.APPROVED,
  BookingStatus.CANCELLED,
];

/**
 * The columns the client fan-out needs, and not one more.
 *
 * 🔴 IT IS A SECOND, NARROWER READ RATHER THAN AN EXTENSION OF `BOOKING_LIST_SELECT`, on purpose.
 * That select is the single owner of the admin queue row and the shape the generated client is typed
 * from; widening it to smuggle `lineUserId` through would put two audiences on one payload. This one
 * is six scalars, one indexed `IN` per emit batch — never one query per id.
 *
 * ⚠️ `lineUserId` HERE IS THE cuid `LineUser.id` (`schema.prisma:749`), which is exactly what
 * `clientUserRoom` wants. Do NOT "correct" it to `lineUser.lineUserId`: that is the LINE-side `U…`
 * subject and would address a room nobody is in.
 */
const CLIENT_FANOUT_SELECT = {
  id: true,
  code: true,
  status: true,
  rejectReason: true,
  lineUserId: true,
  venueId: true,
} satisfies Prisma.BookingRequestSelect;

/**
 * Announces booking movement on the `/client` namespace.
 *
 * Three targeted emits, and the targeting IS the `D-C13` privacy control:
 * - `client.bookingUpdated` → `user:<cuid>`, carrying the code and the reject reason. One person's
 *   room, because those two fields are nobody else's business. Skipped when `lineUserId` is null —
 *   a staff direct booking belongs to no LINE user and has no room to go to.
 * - `client.venueAvailabilityChanged` → `venue:<id>`, carrying **only** the venue id. Shared room,
 *   so it says that availability moved and never whose. This is the one a `PENDING` submission fires:
 *   a pending row occupies the calendar (`OCCUPYING_STATUSES`), so a competing watcher must see the
 *   hour go amber before they submit for it.
 * - `client.scheduleUpdated` → `schedule:all`, **payload-free**, and gated by the separate
 *   {@link SCHEDULE_PULSE_STATUSES} — `APPROVED`/`CANCELLED` only, the two transitions that add or
 *   remove a block from the org-wide day view.
 *
 * 🔴 THE TWO GATES ARE TWO `if`s AGAINST TWO LISTS, and neither may be folded into the other. A
 * `PENDING` row passes the first and must never pass the second.
 *
 * Fail-soft and never rejects, exactly like its caller: the write has already committed.
 */
async function publishClientBookingUpdates(
  prisma: PrismaService,
  client: ClientRealtimeGateway,
  ids: readonly string[],
): Promise<void> {
  try {
    const rows = await prisma.bookingRequest.findMany({
      where: { id: { in: [...ids] } },
      select: CLIENT_FANOUT_SELECT,
    });

    for (const row of rows) {
      if (!CLIENT_ANNOUNCED_STATUSES.includes(row.status)) continue;

      if (row.lineUserId) {
        const payload: ClientBookingUpdatedPayload = {
          id: row.id,
          code: row.code,
          status: row.status,
          rejectReason: row.rejectReason,
        };
        client.emitToUser(
          row.lineUserId,
          CLIENT_REALTIME_EVENTS.bookingUpdated,
          payload,
        );
      }

      const venuePayload: ClientVenueAvailabilityPayload = {
        venueId: row.venueId,
      };
      client.emitToVenue(
        row.venueId,
        CLIENT_REALTIME_EVENTS.venueAvailabilityChanged,
        venuePayload,
      );

      // ⛔ ITS OWN GUARD, AGAINST ITS OWN LIST. `schedule:all` holds everybody, so this branch is a
      // privacy boundary rather than a filter — see `SCHEDULE_PULSE_STATUSES`. A `PENDING` row
      // reached the two emits above and must stop here.
      if (SCHEDULE_PULSE_STATUSES.includes(row.status)) {
        client.emitSchedulePulse();
      }
    }
  } catch (error) {
    // ⚠️ PII DISCIPLINE: ids only. `rejectReason` passes through this function and never reaches a log.
    logger.warn(
      `Client realtime publish failed (write already committed). ids=${ids.join(',')}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
