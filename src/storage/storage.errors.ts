/** One constant per message, so two branches can never drift apart. */

export const AVATAR_REQUIRED =
  'An avatar file is required (form field "file").';
export const AVATAR_TYPE_UNSUPPORTED =
  'Unsupported image type. Upload a JPEG, PNG or WEBP image.';
export const AVATAR_TOO_LARGE = 'The avatar must be 2 MB or smaller.';

/**
 * ⚠️ RENAMED FROM `AVATAR_UPLOAD_FAILED` / `R2_NOT_CONFIGURED` WITH VENUE-1 (2026-08-25), and the
 * wording changed with them. The bucket now holds two kinds of object — staff avatars and venue
 * photos — and a venue photo upload failing with "Avatar storage is unavailable" would send an
 * operator to look at the wrong screen. The three `AVATAR_*` messages above stay avatar-specific
 * because they really are: they name a form field, a size and a type that differ per caller.
 */
export const IMAGE_UPLOAD_FAILED =
  'Image storage is unavailable. Please retry.';
export const STORAGE_NOT_CONFIGURED = 'Image storage is not configured.';
