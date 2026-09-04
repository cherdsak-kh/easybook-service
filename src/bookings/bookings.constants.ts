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
 * 404. The booking does not exist, **or it is not the caller's**.
 *
 * 🔴 ONE ANSWER FOR BOTH, AND NEVER A 403. A 403 on somebody else's booking would confirm that the
 * id exists, which turns `GET /line-users/bookings/:id` into an enumeration oracle over every
 * booking in the product — and `code` is a GUESSABLE label (`BR-` + a date + a three-digit counter),
 * so the oracle would be walkable by hand rather than needing a cuid. Ownership is therefore part
 * of the `where`, not a check after the read: a query that cannot return somebody else's row cannot
 * leak one by accident.
 */
export const BOOKING_NOT_FOUND = 'Booking not found.';

/**
 * 422. Whole-request cancellation attempted on a request that is not `PENDING` (`Q-C4`).
 *
 * ⚠️ 422, NOT 409 — and the difference from {@link VENUE_CLOSED} is real. A closed venue is a fact
 * about the WORLD that may change while the client is looking at it, which is what 409 means here.
 * This is a fact about the REQUEST the caller just named: they addressed a resource whose state
 * cannot accept this verb. `REJECTED` and `CANCELLED` are terminal, and an `APPROVED` request is
 * cancelled per SLOT instead (`Q-C4` ②) — so this refusal is also a redirection, and the client
 * words it as one.
 */
export const BOOKING_NOT_PENDING =
  'Only a pending request can be cancelled as a whole.';

/**
 * 422. Per-slot cancellation attempted on a request that is not `APPROVED`.
 *
 * ⚠️ THE MIRROR OF {@link BOOKING_NOT_PENDING}, and the pair is the whole of `Q-C4`'s table: a
 * PENDING request is cancelled whole (there is nothing to keep), an APPROVED one is cancelled per
 * slot (the other days survive), and the two terminal states accept neither.
 */
export const BOOKING_NOT_APPROVED =
  'Only an approved booking can be cancelled one slot at a time.';

/** 404. No such slot on this booking. Same non-oracle reasoning as {@link BOOKING_NOT_FOUND}. */
export const SLOT_NOT_FOUND = 'Booking slot not found.';

/** 422. The slot is already cancelled — a no-op write, refused rather than faked as a success. */
export const SLOT_ALREADY_CANCELLED = 'This slot is already cancelled.';

/**
 * 422. The slot starts inside the lead-time window, or has already begun.
 *
 * 🔴 THIS IS THE AUTHORISATION BOUNDARY, NOT THE DISABLED BUTTON (`Q-C4` ①). The client hides the
 * control using the lead time it is told; that is UX. A late `PATCH` arrives here with no button
 * involved.
 *
 * ⚠️ ENGLISH, LIKE EVERY OTHER MESSAGE IN THIS FILE — the Thai sentence the screen prints
 * (`ต้องยกเลิกล่วงหน้าอย่างน้อย N นาทีก่อนเวลาเริ่มใช้งาน`) is the CLIENT's, per the file header.
 * It HAS to be, because **N is a setting**: a Thai string frozen at 30 here would still say 30
 * after an operator changed the row, and the one number the sentence exists to communicate would be
 * the only part of it that was wrong. The client words it from `cancelLeadMinutes`, which the
 * booking detail response carries for exactly this purpose.
 */
export const SLOT_CANCEL_TOO_LATE =
  'This slot starts too soon to be cancelled.';

/**
 * ── THE CANCELLATION LEAD TIME (`Q-C4` ①) ──
 * The `app_settings` key, seeded to `'30'` by `20260902085811_add_booking_domain_and_settings`.
 *
 * ⚠️ A SETTING, NOT A CONSTANT — that is the entire ruling, and the reason the value below is named
 * a DEFAULT. `CLIENT-SETTINGS-1` (the admin screen that edits the row) is undesigned; reading the
 * table with a documented default from day one is what stops that screen's arrival being a rework.
 */
export const CANCEL_LEAD_MINUTES_KEY = 'booking.cancel_lead_minutes';

/**
 * Used when the row is missing or unparseable. Thirty minutes, matching the seed.
 *
 * ⚠️ FALLING BACK RATHER THAN THROWING IS DELIBERATE. A missing settings row must not take the
 * cancel button away from every user at once; it is a configuration gap, and the safe reading of a
 * gap here is the documented default, not a 500 on a screen the user is trying to fix something on.
 */
export const CANCEL_LEAD_MINUTES_DEFAULT = 30;

// ── THE ADMIN SURFACE (`booking-requests`) ───────────────────────────────────────────────────────

/**
 * 409. `approve`/`reject` on a request that is not `PENDING`.
 *
 * ⚠️ 409 HERE, WHERE THE LIFF PAIR ABOVE USES 422, AND THE SPLIT IS DELIBERATE. `BOOKING_NOT_PENDING`
 * answers an end-user who addressed their own request with the wrong verb — a fact about the
 * resource they named. This answers a staff member whose queue was accurate when it rendered and is
 * not any more, because somebody else ruled first: a fact about the WORLD that changed under them,
 * which is what 409 means on this surface. The screen re-fetches and shows the new state.
 */
export const BOOKING_NOT_PENDING_FOR_DECISION =
  'Only a pending request can be approved or rejected.';

/**
 * 409. `cancel` on a request that is not `APPROVED`.
 *
 * ⚠️ IT IS ALSO A REDIRECTION: a `PENDING` request is refused with `reject`, which is the path that
 * demands a reason and notifies the requester. Accepting `PENDING` here would open a second road to
 * `CANCELLED` that no button on the screen drives.
 */
export const BOOKING_NOT_APPROVED_FOR_CANCEL =
  'Only an approved booking can be cancelled.';

/** 409. Every slot is already cancelled — there is nothing left to approve or to cancel. */
export const BOOKING_ALREADY_CANCELLED =
  'Every slot of this booking is already cancelled.';

/**
 * 400. A `slotIds` entry that belongs to a different booking.
 *
 * 🔴 REFUSED, NEVER SKIPPED (AC-BR9). Silently ignoring an unknown id would let a client that sent
 * three ids and meant three cancellations get one, report success, and leave two days standing that
 * the operator believes are gone.
 */
export const SLOT_NOT_ON_THIS_BOOKING =
  'A requested slot does not belong to this booking.';

/**
 * 400. A `departmentId` that does not exist or has been soft-deleted (AC-BR13).
 *
 * ⚠️ A CONSTANT OF THE SAME NAME EXISTS IN `line-users.errors.ts` AND `system-users.errors.ts` with
 * different wording. Each module owning its own copy is the house pattern here, not duplication:
 * importing one module's user-facing string into another couples two screens' copy together.
 */
export const INVALID_DEPARTMENT = 'The selected department is not available.';

/**
 * 400. A `lineUserId` on a direct booking that is unknown, soft-deleted, or not `ALLOWED`.
 *
 * ⚠️ ONE MESSAGE FOR THREE STATES, and never a 404: the id is an INPUT to this write, not the
 * resource being addressed, so distinguishing "no such user" from "blocked user" would answer a
 * question the caller did not ask and hand them an enumeration oracle over `line_users`.
 */
export const INVALID_LINE_USER = 'The selected LINE user is not available.';

/**
 * 409. SQLSTATE `40P01` / `40001` — two decisions on one venue collided.
 *
 * ⚠️ IT MEANS "TRY AGAIN", which is why it is not a 500: nothing was written, the caller's intent is
 * still valid, and the advisory lock makes a second attempt very likely to succeed.
 */
export const BOOKING_DECISION_RACE =
  'Another decision on an overlapping booking was in progress. Please try again.';

/** Maximum length of a reject / cancel reason. */
export const BOOKING_REASON_MAX = 500;

/** `requesterName` on a direct booking — the `D-C18` override, long enough for a Thai full name. */
export const BOOKING_REQUESTER_NAME_MAX = 120;

/** `contactPhone` on a direct booking. Wide enough for separators and an extension. */
export const BOOKING_CONTACT_PHONE_MAX = 30;

/**
 * The `rejectReason` written onto every loser of an ADR-001 auto-rejection.
 *
 * 🔴 THAI, WHERE EVERY OTHER STRING IN THIS FILE IS ENGLISH — and that is not an inconsistency. The
 * file header governs ERROR MESSAGES, which a client pairs with a status code before writing its own
 * Thai sentence (`I18N-ERR-1`). This is not an error: it is CONTENT stored in the `rejectReason`
 * column — the same column a staff member types their own reason into — and it is rendered RAW to
 * the requester on My Bookings and in their LINE chat. English here would be an English sentence on
 * a Thai end-user's screen.
 *
 * 🔴 IT NAMES NOBODY (`D-C13`, AC-BR15): no person, no department, no purpose, no winning request's
 * code. Its reader is a DIFFERENT end-user from the winner, and they are not entitled to know who
 * took the room or what for.
 */
export const AUTO_REJECTED_REASON =
  'ช่วงเวลาที่ขอถูกจัดสรรให้การจองอื่นแล้ว จึงไม่สามารถอนุมัติคำขอนี้ได้';

/**
 * The `pg_advisory_xact_lock` namespace for booking decisions, keyed by `hashtext(venueId)`.
 *
 * 🔴 WITHOUT IT, TWO SIMULTANEOUS APPROVALS OF OVERLAPPING REQUESTS DEADLOCK rather than one losing
 * politely: each transaction flips its own request (taking a row lock and an index entry) and then
 * tries to reject the other's, which the other already holds. No ordering of the two writes escapes
 * it, because both transactions write the same two rows in opposite directions.
 *
 * ⚠️ IT DOES NOT REPLACE THE CONSTRAINT AND MUST NEVER BE READ AS DOING SO. The lock makes the
 * refusal POLITE; `booking_slots_no_overlap` makes it CERTAIN. A future route that forgets the lock
 * still cannot double-book — it just gets a raw `23P01` instead of a considered `409`.
 *
 * A fixed namespace so a later feature's advisory lock cannot collide with this one. `hashtext`
 * returns `int4`, so two venue ids can hash together and serialise unnecessarily: that costs
 * throughput on a product with dozens of rooms, and costs no correctness.
 */
export const BOOKING_VENUE_LOCK_NS = 4210;

/**
 * `BookingSlot.cancelledByRole` for a cancellation made through the LIFF app.
 *
 * ⚠️ IT IS NOT A FOREIGN KEY AND RESOLVES NOTHING ON ITS OWN. `cancelledById` may point into
 * `line_users` OR `system_users` — two tables this schema deliberately gives no bridge — and this
 * column is the only thing that says which. The schema's writer's contract is that the pair is
 * written together, always.
 */
export const CANCELLED_BY_LINE_USER = 'LINE_USER';

/** `q` on the My Bookings list. The same ceiling every other search box in this service uses. */
export const BOOKING_SEARCH_MAX = 100;

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
