/**
 * One constant per message and per limit, so two branches — and the two repos — can never drift.
 *
 * The 404/409 texts are NOT imported from `src/options/options.errors`, unlike `/venue-types` and
 * `/amenities`. Those three tables share a contract (a curated name list) and deliberately answer
 * identically; a venue is an entity with its own vocabulary on screen, and reusing
 * "ไม่พบตัวเลือกที่ระบุ" for a missing room would be one caller's sentence living in the wrong file.
 */

/** `GET`/`PATCH`/`DELETE` on an unknown, soft-deleted id. Also what a second DELETE answers. */
export const VENUE_NOT_FOUND = 'Venue not found.';

/** 409 from the `venues_name_active_key` partial index. A soft-deleted name is reusable. */
export const VENUE_NAME_TAKEN = 'A venue with this name already exists.';

/**
 * ⚠️ THE SAME 400 FOR THREE DIFFERENT CAUSES, and that is the design: an id that never existed, an
 * id that was soft-deleted, and the RESERVED tombstone row all answer with this one string.
 *
 * A distinct status for the reserved case would be an existence oracle, and the rule this repo
 * already holds is that *reserved must be indistinguishable from never-existed* — never a 403.
 * (`AC-S2` asserts the two bodies are byte-identical.)
 */
export const INVALID_VENUE_TYPE =
  'The selected venue type does not exist or is not available.';

/** Same construction as above, for the amenity ticks. Any id in the set that is not ACTIVE. */
export const INVALID_AMENITY =
  'One or more selected amenities do not exist or are not available.';

/**
 * `POST /venues/:id/close` with an empty reason.
 *
 * The reason is REQUIRED here where `LineUser.blockReason` is optional, and the difference is who
 * reads it: a block reason is an internal note, this one prints on the venue card and — once LIFF
 * exists — in front of everybody who tries to book the room. It follows `rejectionReason`.
 */
export const CLOSE_REASON_REQUIRED =
  'A reason is required when closing a venue.';

/** `POST /venues/:id/close` on a venue that is already closed, or `/reopen` on an open one. */
export const VENUE_ALREADY_IN_STATE =
  'The venue is already in the requested state.';

/**
 * The photo ceiling (`Q19`, PO 2026-08-25). Ten.
 *
 * ⚠️ THE FORM ENFORCES IT TOO, AND THAT IS NOT DUPLICATION. The picker's copy is UX — it takes what
 * fits and says what it refused. This one is the contract: a limit enforced only in the picker is a
 * suggestion, because `POST` is reachable without it.
 */
export const VENUE_PHOTOS_MAX = 10;

/** 5 MiB — larger than an avatar (2 MiB) because a room is not a face at 96px. */
export const VENUE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What multer is actually handed: `VENUE_PHOTO_MAX_BYTES + 1`.
 *
 * ⚠️ NOT A FUDGE — busboy's `limits.fileSize` is EXCLUSIVE (it emits `'limit'` when the byte count
 * `===` the limit), so passing 5 MiB would reject a file of exactly 5 MiB and make the real ceiling
 * 5 MiB − 1. That would contradict the message below and the client-side pre-check. This is the
 * avatar path's trap, repeated here because the trap is in busboy, not in the avatar code.
 */
export const VENUE_PHOTO_MULTER_SIZE_LIMIT = VENUE_PHOTO_MAX_BYTES + 1;

export const VENUE_PHOTO_REQUIRED =
  'A photo file is required (form field "file").';
export const VENUE_PHOTO_TOO_LARGE = 'The photo must be 5 MB or smaller.';
export const VENUE_PHOTO_TYPE_UNSUPPORTED =
  'Unsupported image type. Upload a JPEG, PNG or WEBP image.';

/**
 * `DELETE /venues/photos` on a URL some venue still references.
 *
 * ⚠️ THIS REFUSAL IS WHAT MAKES THE DISCARD ENDPOINT SAFE TO EXPOSE. Without it the route would be
 * "delete any venue photo by URL", which would leave a live `venue_photos` row pointing at a dead
 * object — a state nothing else in this schema can produce. Removing a photo from a venue is a
 * `PATCH` of `photoUrls`, and that path deletes the dropped objects itself.
 */
export const VENUE_PHOTO_IN_USE =
  'This photo belongs to a venue. Remove it from the venue instead.';

/**
 * A `photoUrls` entry that is not an object in OUR bucket.
 *
 * ⚠️ STRICTER THAN THE AVATAR CONTRACT, deliberately. `SystemUser.profilePictureUrl` accepts an
 * arbitrary external URL because an administrator setting one is a designed feature there. No such
 * feature exists for venues: every URL on this table is minted by `POST /venues/photos`, and keeping
 * it that way is what makes two other things true — the venue card can never become a hotlink to a
 * host nobody controls, and "replace the whole set" can safely delete the objects it dropped,
 * because every one of them is ours.
 */
export const INVALID_PHOTO_URL =
  'Photo URLs must point at uploaded venue photos.';
