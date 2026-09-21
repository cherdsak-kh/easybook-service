import { FeedbackType } from '@prisma/client';

/**
 * One constant per message and per limit, following `src/bookings/bookings.constants.ts` and
 * `src/venues/venues.constants.ts`.
 *
 * ⚠️ THESE ARE ENGLISH, and the client portal's are Thai. `I18N-ERR-1` governs what the LIFF screens
 * PRINT: the client maps a status code to its own Thai sentence. A backend string that leaked onto a
 * Thai screen would be a bug in the client, not here.
 *
 * ⚠️ THIS MODULE OWNS ITS OWN STRINGS AND ITS OWN CODE CONSTANTS, rather than importing the booking
 * module's. That is the house rule `bookings.constants.ts` states for itself — importing one
 * module's user-facing string into another couples two screens' copy together. What IS shared with
 * bookings is only the pure date/collision machinery in `../bookings/booking-code`, which has no
 * copy in it at all.
 */

// ── SUBMIT (`POST /line-users/feedback`) ─────────────────────────────────────────────────────────

/**
 * 403. The caller's `AppAccess` is not `ALLOWED`.
 *
 * ⚠️ ONE MESSAGE FOR FOUR STATES (`UNREGISTERED` / `PENDING` / `REJECTED` / `BLOCKED`) — and for a
 * soft-deleted (unfollowed) row too, which is treated as absent. Distinguishing them would answer a
 * question the caller did not ask and hand out an existence oracle over `line_users`; the client
 * already knows which screen it belongs on, because `GET /line-users/status` is the single source
 * for that (`TRANSPORT.md` §5).
 */
export const FEEDBACK_NOT_ALLOWED =
  'Your account is not approved for submitting feedback.';

/**
 * 400 — NOT 404 (`E-5`). The venue is an INPUT to this write, not the resource being addressed, so
 * it follows `INVALID_LINE_USER` in `bookings.constants.ts`: one message for "never existed" and
 * "soft-deleted", and no enumeration oracle over `venues`.
 *
 * ⚠️ `isOpen` IS DELIBERATELY NOT CHECKED. A closed venue is exactly the venue somebody needs to
 * report a problem about; `VENUE_CLOSED` belongs to booking, not to reporting.
 */
export const FEEDBACK_VENUE_INVALID =
  'The selected venue does not exist or is not available.';

/**
 * 400. A `photos` entry that is not an object this deployment minted.
 *
 * 🔴 NEVER TRUST A URL THAT IS NOT OURS — the same prefix guard `VenuePhotoUploadService.discard`
 * applies, and the reason is sharper here: this column is rendered by a future admin screen, so an
 * unchecked entry would be an attacker-chosen link on a staff member's screen.
 */
export const FEEDBACK_PHOTO_URL_INVALID =
  'Photo URLs must point at uploaded feedback photos.';

/** `หัวข้อ` — `maxlength="100"` on the prototype's subject input (AC-11). */
export const FEEDBACK_SUBJECT_MAX = 100;

/**
 * `รายละเอียด` — 500 characters, AFTER trimming (E-9: exactly 500 is valid, 501 is not).
 *
 * 🔴 THE ONLY CAP THAT EXISTS. The column is unbounded `text` (see `Feedback.description`), so this
 * DTO bound is the product rule, and it must REFUSE rather than truncate: AC-12 leaves the textarea
 * without a `maxlength`, so over-length text is typeable and the client disables submit instead of
 * silently eating the end of a pasted paragraph.
 */
export const FEEDBACK_DESCRIPTION_MAX = 500;

/** Attachments per submission. Three — the prototype hides the dropzone at this count (AC-19). */
export const FEEDBACK_PHOTOS_MAX = 3;

/** Per-entry ceiling on a `photos` URL. Generous: the prefix guard is the real control. */
export const FEEDBACK_PHOTO_URL_MAX = 512;

/** `venueId` — the same shape bound `CreateLineBookingDto.venueId` uses for a cuid. */
export const FEEDBACK_VENUE_ID_MAX = 64;

// ── THE HUMAN-READABLE REFERENCE ─────────────────────────────────────────────────────────────────

/**
 * `ISS-25690920-001` / `FDB-25690920-001` — the string the success dialog prints in `font-mono` and
 * the user quotes to staff on the phone (AC-38).
 *
 * ⚠️ A TABLE, NEVER TWO `if`s — the same "one row per type, no branching" rule the prototype's
 * `IS_TYPES` follows (AC-7). A third type is one entry here and nothing else.
 *
 * `BANGKOK_UTC_OFFSET_MINUTES` / `BUDDHIST_ERA_OFFSET` are deliberately NOT re-declared in this
 * file: they reach this module only through the functions imported from `../bookings/booking-code`,
 * so the BE offset and the UTC+7 shift have exactly one definition in the repo.
 */
export const FEEDBACK_CODE_PREFIX: Record<FeedbackType, string> = {
  ISSUE: 'ISS',
  FEEDBACK: 'FDB',
};

/**
 * Zero-padded width of the per-day sequence. Three digits.
 *
 * ⚠️ ITS OWN CONSTANT, not `BOOKING_CODE_SEQUENCE_WIDTH`, so a future change to the booking width
 * cannot silently reformat every feedback reference.
 */
export const FEEDBACK_CODE_SEQUENCE_WIDTH = 3;

/**
 * How many times a submit re-runs after losing the race for a `code`.
 *
 * ⚠️ THE SEQUENCE IS COUNTED, NOT RESERVED, exactly as `BOOKING_CODE_MAX_ATTEMPTS` describes: two
 * submissions in the same millisecond compute the same number, `code` is `@unique` so the loser
 * takes a `P2002`, and the fix is to run the whole transaction again so the count sees the row that
 * beat it.
 *
 * ⚠️ ONE DEVIATION IN RISK PROFILE FROM BOOKINGS, RECORDED BECAUSE IT IS REAL. That constant's
 * comment says the scheme cannot recover from a row being HARD-deleted after its code was minted,
 * and is safe today only because "nothing in this product hard-deletes a booking". **Feedback has
 * such a path**: `onDelete: Cascade` on `lineUserId` means a right-to-erasure hard delete of a
 * `LineUser` hard-deletes their submissions. If that happens on the SAME Bangkok day as new
 * submissions of the same type, the day's count drops, every retry recomputes a taken number, and
 * the submission fails after five attempts with a 500.
 *
 * Accepted, not engineered away, because the alternatives are worse and the exposure is tiny:
 * erasure is a manual, rare, out-of-band action, the window is one calendar day, and the obvious
 * fix — deriving the sequence from `MAX(code)` instead of `COUNT` — breaks at exactly the point the
 * width grows, since `'1000' < '999'` lexicographically and an `orderBy: { code: 'desc' }` would
 * hand back `999` forever after the thousandth code.
 */
export const FEEDBACK_CODE_MAX_ATTEMPTS = 5;

// ── PHOTO UPLOAD (`POST /line-users/feedback/photos`) ────────────────────────────────────────────

/**
 * What the sniffer must return for the bytes to be stored. JPEG and PNG (AC-39).
 *
 * 🔴 NARROWER THAN `isAvatarImageType`, AND THAT IS THE POINT. `sniffImageType` also recognises
 * webp and the avatar/venue allowlist accepts it, but AC-39 allows two types and the client rejects
 * webp before upload — so a server that accepted it would be accepting something no screen can
 * produce. The sniffer itself is reused UNCHANGED; only this allowlist is local.
 */
export const FEEDBACK_PHOTO_TYPES = ['image/jpeg', 'image/png'] as const;

export type FeedbackPhotoType = (typeof FEEDBACK_PHOTO_TYPES)[number];

/** True for the two types this route stores — the local narrowing of `isAvatarImageType`. */
export const isFeedbackPhotoType = (
  value: string,
): value is FeedbackPhotoType =>
  (FEEDBACK_PHOTO_TYPES as readonly string[]).includes(value);

/** 5 MiB per photo — the same ceiling as a venue photo, and what the picker pre-checks (AC-20). */
export const FEEDBACK_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What multer is actually handed: `FEEDBACK_PHOTO_MAX_BYTES + 1`.
 *
 * ⚠️ NOT A FUDGE — busboy's `limits.fileSize` is EXCLUSIVE (it emits `'limit'` when the byte count
 * `===` the limit), so passing 5 MiB would reject a file of exactly 5 MiB and make the real ceiling
 * 5 MiB − 1, contradicting the message below and the client's pre-check. The trap is in busboy, not
 * in the avatar or venue code, which is why it repeats here.
 */
export const FEEDBACK_PHOTO_MULTER_SIZE_LIMIT = FEEDBACK_PHOTO_MAX_BYTES + 1;

export const FEEDBACK_PHOTO_REQUIRED =
  'A photo file is required (form field "file").';

/**
 * 400, NOT the 413 the stack produces by default (AC-40).
 *
 * `FileInterceptor` maps multer's `LIMIT_FILE_SIZE` to a `PayloadTooLargeException` before any
 * filter sees a `MulterError`, so `MulterErrorTo400Filter` — passed this message as an INSTANCE —
 * is the only thing that makes the status right.
 */
export const FEEDBACK_PHOTO_TOO_LARGE = 'The photo must be 5 MB or smaller.';

/** One message for "not declared as an image we take", "not one at all", and "mislabelled". */
export const FEEDBACK_PHOTO_TYPE_UNSUPPORTED =
  'Unsupported image type. Upload a JPEG or PNG image.';
