/**
 * One constant per message and per limit, following `src/venues/venues.constants.ts`.
 *
 * ⚠️ THESE ARE ENGLISH, and the client portal's are Thai. That is not an inconsistency: `I18N-ERR-1`
 * governs what the LIFF screens PRINT, and the client maps a status code to its own Thai sentence
 * (`registration-api.ts`'s `messageFor`). A backend string that leaked onto a Thai screen would be a
 * bug in the client, not here — and every other module in this service is English.
 */

/** 404. An unknown venue id, a soft-deleted one, and "not yours" all answer identically. */
export const VENUE_NOT_FOUND = 'Venue not found.';

/**
 * 409 on submitting against a CLOSED venue.
 *
 * ⚠️ A CLOSED VENUE IS NOT A HIDDEN ONE. `Venue.isOpen` documents itself as "stays VISIBLE to end
 * users but accepts no NEW booking requests", and the client renders `closedReason` as an alert with
 * a disabled CTA. This is the server half of that: the disabled button is UX, and UX is not an
 * authorisation boundary — `POST` is reachable without it.
 */
export const VENUE_CLOSED = 'This venue is not accepting booking requests.';

/**
 * 403. The caller's `AppAccess` is not `ALLOWED`.
 *
 * ⚠️ ONE MESSAGE FOR FOUR STATES (`UNREGISTERED` / `PENDING` / `REJECTED` / `BLOCKED`). The client
 * never needs to distinguish them here because it already knows: `GET /line-users/status` is the
 * single source for "which screen next" (`TRANSPORT.md` §5), and a caller who reaches this endpoint
 * without `ALLOWED` has bypassed the gate rather than lost a race.
 */
export const BOOKING_NOT_ALLOWED =
  'Your account is not approved for booking requests.';

/** 400. A slot whose `startAt` is not strictly before its `endAt`. */
export const SLOT_RANGE_INVALID = 'Each slot must end after it starts.';

/**
 * 400. `D-C16` — no booking in the past, checked per slot against the REAL CLOCK.
 *
 * 🔴 NOW, NEVER TODAY. Today is still bookable at 09:00 for 14:00, so a midnight comparison would
 * refuse a legitimate same-day request for the rest of the working day.
 */
export const SLOT_IN_THE_PAST = 'A booking cannot start in the past.';

/**
 * 400. Two slots of the SAME request overlap each other.
 *
 * ⚠️ THIS IS A DIFFERENT REFUSAL FROM {@link SLOT_TAKEN}, and the difference is whose fault it is. A
 * request that overlaps itself is incoherent input — it asks for one room twice at once — and no
 * approver decision could ever make it valid. A clash with somebody else's approved booking is a
 * fact about the world, so it is a 409.
 */
export const SLOT_SELF_OVERLAP = 'The requested slots overlap each other.';

/**
 * 409. A requested slot collides with an APPROVED, non-cancelled slot at the same venue.
 *
 * 🔴 PENDING REQUESTS DO NOT TRIGGER THIS (`D-C13` rule 4): a pending request holds nothing, several
 * people may ask for the same hours, and all of them get `PENDING`. Refusing on a pending clash
 * would quietly convert first-to-submit into first-to-win, which is exactly the behaviour rule 4
 * exists to deny.
 *
 * ⚠️ IT NAMES NOTHING. Not who holds the slot, not what for (`D-C13`'s privacy clause).
 */
export const SLOT_TAKEN =
  'One or more of the requested times is already booked.';

/**
 * 400. `from` later than `to` on the availability query.
 *
 * The range is otherwise permissive — see {@link AVAILABILITY_MAX_DAYS} for the only other bound.
 */
export const AVAILABILITY_RANGE_INVALID =
  'The `to` date must not be earlier than `from`.';

/** 400. A range wider than {@link AVAILABILITY_MAX_DAYS}. */
export const AVAILABILITY_RANGE_TOO_WIDE =
  'The requested date range is too wide.';

/**
 * Slots per request. Sixty.
 *
 * ⚠️ IT IS A CEILING ON THE SHAPE, NOT ON THE PRODUCT. `D-C13` rule 2 says the two supported shapes
 * — one continuous span and a repeat across several days — differ ONLY in how many rows land in
 * `booking_slots`, so this number is the only thing separating them and must be generous enough that
 * a term-long weekly class fits. Sixty covers two per week for a 30-week academic year.
 */
export const BOOKING_SLOTS_MAX = 60;

/** `purpose` — long enough for a sentence an approver can act on, short enough not to be a note. */
export const BOOKING_PURPOSE_MAX = 500;

/**
 * `attendees` — the upper bound exists only to keep an obvious typo out of the column. The venue's
 * own `capacity` is NOT checked against it, deliberately: rooms are regularly booked for fewer
 * people than they seat, and an over-capacity request is a judgement for the approver rather than a
 * validation failure.
 */
export const BOOKING_ATTENDEES_MAX = 10_000;

/**
 * The widest availability window one call may ask for, in days. 366 — a leap year.
 *
 * The calendar asks for a month at a time; this bound exists so a hand-written `from=1900` cannot
 * ask the database to scan the whole table.
 */
export const AVAILABILITY_MAX_DAYS = 366;

/** How many days `from`/`to` default to when the caller omits them: the current calendar month. */
export const AVAILABILITY_DEFAULT_IS_CURRENT_MONTH = true;

/**
 * ── THE HUMAN-READABLE BOOKING NUMBER ──
 * `BR-25690902-001` — prefix, Buddhist-era `yyyyMMdd`, and a per-day sequence. Fixed by the model
 * comment on `BookingRequest.code`, which is the string a user pastes out of a LINE chat into the My
 * Bookings search box.
 */
export const BOOKING_CODE_PREFIX = 'BR';

/** 2026 CE → 2569 BE. The calendar every date on a Thai school's paperwork is written in. */
export const BUDDHIST_ERA_OFFSET = 543;

/**
 * 🔴 THE CODE'S DATE IS BANGKOK'S, NOT THE SERVER'S. A container running in UTC would mint
 * `BR-25690902-…` for a request submitted at 06:30 on the 3rd of September Thai time, and the user
 * reading it off their phone would be looking at yesterday's date on today's booking.
 *
 * ⚠️ A FIXED OFFSET, NOT A TIME ZONE — and for Thailand those are the same thing. `Asia/Bangkok` has
 * been UTC+7 with no daylight saving since 1920, so `Intl` would buy nothing here but a dependency
 * on the container's ICU data being complete (a `full-icu`-less Node prints `GMT+7` and formats in
 * English regardless). This is deliberate and does not generalise to other zones.
 */
export const BANGKOK_UTC_OFFSET_MINUTES = 420;

/** Zero-padded width of the per-day sequence. Three digits — 999 requests in one day. */
export const BOOKING_CODE_SEQUENCE_WIDTH = 3;

/**
 * How many times a create re-runs after losing the race for a `code`.
 *
 * ⚠️ THE SEQUENCE IS COUNTED, NOT RESERVED, so two requests submitted in the same millisecond can
 * compute the same number. `code` is `@unique`, so the loser gets a `P2002` rather than a duplicate,
 * and the fix is to count again — the second attempt sees the row the first one wrote. A counter
 * table would serialise every booking in the product behind one row to avoid a collision that needs
 * two submissions in the same instant.
 *
 * ⚠️ THE ONE CASE THIS CANNOT RECOVER FROM is a `booking_requests` row being HARD-deleted after its
 * code was minted: the count drops back, every retry recomputes the same taken number, and the
 * submission fails after the last attempt. It is safe today because nothing in this product hard-
 * deletes a booking — there is no such code path and no such endpoint. Whoever adds one is the
 * person who has to replace this counter with a reserved sequence.
 *
 * ⚠️ The count is over EVERY request created that Bangkok day, not only those whose code matches the
 * pattern — an admin direct booking increments it too. That only ever skips a number, never reuses
 * one, which is the correct direction for a label whose whole job is to be unique.
 */
export const BOOKING_CODE_MAX_ATTEMPTS = 5;
