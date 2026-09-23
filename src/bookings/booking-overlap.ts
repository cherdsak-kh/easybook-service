import { BadRequestException, ConflictException } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { isWriteConflict } from '../common/prisma-tx.util';
import {
  SLOT_IN_THE_PAST,
  SLOT_RANGE_INVALID,
  SLOT_SELF_OVERLAP,
  SLOT_TAKEN,
} from './bookings.constants';

/**
 * ── THE SINGLE OWNER OF THE OVERLAP RULE (AC-BR19) ──
 *
 * A pure function module, not an `@Injectable()`: every entry point takes the transaction client it
 * must run inside as an argument and holds no state, exactly like `booking-code.ts`. Making it a
 * provider would mean the LIFF service and the admin service each injecting a class to reach two
 * `where` builders, and would let one of them be replaced in a test with a version that disagrees.
 *
 * 🔴 THE HALF-OPEN COMPARISON APPEARS ONCE IN THIS REPO'S TYPESCRIPT, in {@link overlapOr}. Three
 * copies would be three chances to type `<` as `<=`, and the failure mode is an auditorium
 * double-booked while every screen in the product says it is free. The DATABASE says the same rule a
 * second time, in `booking_slots_no_overlap`'s `tsrange(..., '[)')` — that is not a third copy but
 * the enforcement boundary ADR-001 asks for, and the two must agree.
 */

/** A slot after parsing, with real `Date`s instead of the DTO's strings. */
export type SlotSpan = { start: Date; end: Date };

/**
 * One `where` clause per requested span: `theirs.start < mine.end && theirs.end > mine.start`.
 *
 * ⚠️ HALF-OPEN `[start, end)`. A slot ending 12:00 and one starting 12:00 do NOT overlap
 * (`AC-BR18`), which is why both comparisons are strict. `startAt = endAt` is an empty span that
 * overlaps nothing — consistent with {@link parseSlots}, which refuses it at the 400 boundary before
 * it can ever reach here.
 */
export function overlapOr(
  spans: readonly SlotSpan[],
): Prisma.BookingSlotWhereInput[] {
  return spans.map((s) => ({
    startAt: { lt: s.end },
    endAt: { gt: s.start },
  }));
}

/**
 * "Slots that are APPROVED, not cancelled, at this venue, and overlap `spans`."
 *
 * 🔴 THE PREDICATE READS THE PARENT'S `status`, NOT `holdsSlot`. The trigger-maintained column is an
 * INDEX KEY the database owns (see `schema.prisma`); the moment application code reads it as a fact
 * it becomes the second store of truth `Q-C4` sub-ruling 2 forbids. `bookings.service.spec.ts`
 * asserts this exact shape, and that assertion is load-bearing rather than incidental.
 *
 * `excludeRequestId` exists for `approve`, where the request being approved must not be counted as
 * clashing with itself.
 */
export function approvedClashWhere(
  venueId: string,
  spans: readonly SlotSpan[],
  excludeRequestId?: string,
): Prisma.BookingSlotWhereInput {
  return {
    venueId,
    isCancelled: false,
    bookingRequest: { status: BookingStatus.APPROVED },
    ...(excludeRequestId
      ? { bookingRequestId: { not: excludeRequestId } }
      : {}),
    OR: overlapOr(spans),
  };
}

/**
 * The clash, or `null` — the READING variant, for `GET /booking-requests/:id`'s `conflicts` block.
 *
 * ⚠️ ITS ANSWER IS ADVICE, NOT A PROMISE, when called outside the deciding transaction. A request
 * that reads "no clash" may still be refused a second later; the binding refusal is
 * {@link assertNoApprovedClash} running inside the approval transaction.
 */
export async function findApprovedClash(
  tx: Prisma.TransactionClient,
  venueId: string,
  spans: readonly SlotSpan[],
  opts?: { excludeRequestId?: string },
): Promise<{ id: string; bookingRequestId: string } | null> {
  if (spans.length === 0) return null;
  return tx.bookingSlot.findFirst({
    where: approvedClashWhere(venueId, spans, opts?.excludeRequestId),
    select: { id: true, bookingRequestId: true },
  });
}

/**
 * The THROWING variant — the hard block (`AC-BR17`).
 *
 * 🔴 APPROVED ONLY. A `PENDING` clash is NOT an error (`D-C13` rule 4): several people may request
 * the same hours and all of them get `PENDING`; the approver picks one and the losers are
 * auto-rejected. Refusing here on a pending clash would silently turn the product into
 * first-to-submit-wins and delete the decision approval exists to make.
 *
 * ⚠️ The refusal names nothing — not who holds the slot, not what for (`D-C13`).
 */
export async function assertNoApprovedClash(
  tx: Prisma.TransactionClient,
  venueId: string,
  spans: readonly SlotSpan[],
  opts?: { excludeRequestId?: string },
): Promise<void> {
  const clash = await findApprovedClash(tx, venueId, spans, opts);
  if (clash) throw new ConflictException(SLOT_TAKEN);
}

/**
 * 🔴 ADR-001's LOSERS: the `PENDING` requests this decision is about to reject, RETURNED rather than
 * thrown.
 *
 * ⚠️ CALL IT BEFORE FLIPPING THE DECIDING REQUEST'S OWN STATUS (`AC-BR14`, README: "เก็บรายชื่อ
 * ผู้แพ้ให้ครบ *ก่อน* เปลี่ยนสถานะ"). Read afterwards, the set returned to the screen would be a
 * different set from the one actually written — and the next person to touch this code would filter
 * `PENDING` at a moment when the answer had already changed. Read once, write once.
 *
 * One row per request by construction (`slots: { some: … }` rather than a slot query), so no DISTINCT
 * is needed. Ordered by `code` so two runs over the same data report the same list.
 */
export async function findPendingLosers(
  tx: Prisma.TransactionClient,
  venueId: string,
  spans: readonly SlotSpan[],
  opts: { excludeRequestId?: string } = {},
): Promise<
  { id: string; code: string; firstStartAt: Date; lastEndAt: Date }[]
> {
  if (spans.length === 0) return [];
  return tx.bookingRequest.findMany({
    where: {
      venueId,
      status: BookingStatus.PENDING,
      ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}),
      slots: { some: { isCancelled: false, OR: overlapOr(spans) } },
    },
    select: { id: true, code: true, firstStartAt: true, lastEndAt: true },
    orderBy: { code: 'asc' },
  });
}

/**
 * Strings → `Date`s, with the three semantic checks `class-validator` cannot express: a span must
 * end after it starts, must not start in the past, and must not overlap another span of the SAME
 * request.
 */
export function parseSlots(
  input: readonly { startAt: string; endAt: string }[],
): SlotSpan[] {
  const now = Date.now();
  const slots = input.map(({ startAt, endAt }) => {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException(SLOT_RANGE_INVALID);
    }
    // 🔴 `D-C16` — compared against NOW, never against midnight today. It is still legitimate at
    // 09:00 to book this afternoon, and a same-day comparison would refuse it.
    if (start.getTime() <= now) {
      throw new BadRequestException(SLOT_IN_THE_PAST);
    }
    return { start, end };
  });

  // n² over at most `BOOKING_SLOTS_MAX` entries — 60 is 1,770 comparisons, and sorting first to get
  // an O(n log n) sweep would mean reordering the caller's slots or carrying indices to report on.
  const sorted = [...slots].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start.getTime() < sorted[i - 1].end.getTime()) {
      throw new BadRequestException(SLOT_SELF_OVERLAP);
    }
  }
  return slots;
}

/** The exclusion constraint's name. Matched as a fallback — see {@link isOverlapViolation}. */
export const OVERLAP_CONSTRAINT = 'booking_slots_no_overlap';

/** SQLSTATE 23P01 — `exclusion_violation`. Not mapped to any Prisma error code. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * 🔴 SQLSTATE `23P01` REACHING THE CLIENT AS A `500` IS THE FAILURE `AC-BR22` FORBIDS.
 *
 * Prisma ships codes for `23505 → P2002` and `23503 → P2003` and **nothing for `23P01`**, so an
 * exclusion violation is not a `PrismaClientKnownRequestError` at all. MEASURED against this
 * deployment on 2026-09-04 (Prisma 7 + `@prisma/adapter-pg`), the shape is:
 *
 * ```
 * DriverAdapterError                      // not a PrismaClientKnownRequestError, code: undefined
 *   .message  'conflicting key value violates exclusion constraint "booking_slots_no_overlap"'
 *   .cause    { code: '23P01', originalCode: '23P01', message: <same> }
 * ```
 *
 * — identical from a nested `create` (the `direct` path), from an `updateMany` of
 * `booking_requests` (the `approve` path, where the parent trigger is what trips it), and from
 * inside an interactive `$transaction`.
 *
 * TWO NETS, because that shape is a driver-version detail and the next upgrade may re-wrap it:
 * the SQLSTATE anywhere in the `cause`/`meta.cause` chain, **or** the constraint's own name in any
 * message on that chain. The name is shape-independent.
 *
 * ⚠️ IT RETURNS FALSE FOR EVERYTHING ELSE, and the caller must rethrow rather than answer `409`.
 * Swallowing an unrecognised error as a conflict would turn a real bug into a plausible-looking
 * refusal that nobody investigates.
 */
export function isOverlapViolation(err: unknown): boolean {
  for (const node of errorChain(err)) {
    const code =
      typeof node.originalCode === 'string' ? node.originalCode : node.code;
    if (code === EXCLUSION_VIOLATION) return true;
    if (
      typeof node.message === 'string' &&
      node.message.includes(OVERLAP_CONSTRAINT)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `40P01` (deadlock) / `40001` (serialization failure) → a RETRYABLE `409`, never a `500`.
 *
 * The advisory lock in `AdminBookingsService` is what makes these rare rather than routine — two
 * decisions on one venue are serialised before either reads anything — but "rare" is not "never",
 * and a route that has not taken the lock yet (or a future one that forgets) must still refuse
 * politely.
 *
 * ⚠️ ONE OWNER FOR THE SQLSTATE WALK: this delegates to `isWriteConflict`, which the staff-management
 * surface already relies on for the same two codes. A second copy here would be a second place to
 * fix when the adapter changes how it wraps a deadlock.
 */
export function isTransactionRace(err: unknown): boolean {
  return isWriteConflict(err);
}

/** `err`, `err.cause`, `err.meta.cause`, … — bounded, because a cyclic `cause` is not impossible. */
function* errorChain(
  err: unknown,
): Generator<{ code?: unknown; originalCode?: unknown; message?: unknown }> {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur == null || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const node = cur as {
      code?: unknown;
      originalCode?: unknown;
      message?: unknown;
      cause?: unknown;
      meta?: { cause?: unknown };
    };
    yield node;
    queue.push(node.cause, node.meta?.cause);
  }
}
