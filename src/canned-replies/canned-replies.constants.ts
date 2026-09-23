/**
 * `ข้อความตอบกลับด่วน` — the admin-curated canned replies staff copy into the LINE OA chat console
 * (ANNOUNCE-API-5, plan D-3…D-5).
 *
 * ⚠️ THIS MODULE OWNS ITS OWN STRINGS, rather than importing the announcements module's — the house
 * rule `announcements.constants.ts` states: importing one module's user-facing string into another
 * couples two screens' copy together.
 *
 * Service-thrown errors carry these as ONE string `message` next to a `code`; the ValidationPipe's
 * refusals keep Nest's `string[]` and carry no `code`.
 */

// ── LIMITS ───────────────────────────────────────────────────────────────────────────────────────

/** `title` — 1–100 characters AFTER trimming. Lives in the DTO; the column is unbounded `text`. */
export const CANNED_REPLY_TITLE_MAX = 100;

/** `text` — 1–1000 characters AFTER trimming. Lives in the DTO; the column is unbounded `text`. */
export const CANNED_REPLY_TEXT_MAX = 1000;

/** `sortOrder` — 0…this. A POST that omits it gets `min(max + 1, this)` (design S-4). */
export const CANNED_REPLY_SORT_ORDER_MAX = 9999;

/** D-3 — the table never holds more than this; enforced in `create` under CANNED_REPLIES_LOCK_NS. */
export const CANNED_REPLIES_MAX = 5;

/**
 * `pg_advisory_xact_lock(NS, 0)` namespace for canned-reply creation (D-3). Must differ from every
 * other namespace: today only BOOKING_VENUE_LOCK_NS = 4210 (src/bookings/bookings.constants.ts).
 * Key 2 is a constant 0: the lock is table-wide.
 */
export const CANNED_REPLIES_LOCK_NS = 4220;

// ── MESSAGES ─────────────────────────────────────────────────────────────────────────────────────

/** 400 `CANNED_REPLIES_LIMIT_EXCEEDED` — PO wording, Thai. */
export const CANNED_REPLIES_LIMIT_EXCEEDED =
  'ข้อความตอบกลับด่วนสามารถมีได้สูงสุดไม่เกิน 5 ข้อความ';

/** 404 `CANNED_REPLY_NOT_FOUND` — unknown and malformed ids alike (no cuid pipe). */
export const CANNED_REPLY_NOT_FOUND = 'Canned reply not found.';

/** 400 `CANNED_REPLY_UPDATE_EMPTY` — a PATCH with every field absent (the phase-1 precedent). */
export const CANNED_REPLY_UPDATE_EMPTY =
  'Provide at least one field to update.';
