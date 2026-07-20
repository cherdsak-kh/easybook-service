/**
 * Magic-byte image sniffing — THE control behind AC-B13.
 *
 * `file.mimetype` is whatever the client typed in the multipart part header, and `originalname` is
 * attacker-controlled (the classic path-traversal / double-extension vector). Neither is evidence.
 * Only the bytes are. This is exactly the check a presigned upload could not perform: a POST policy
 * constrains the Content-Type the client *declares*, so `Content-Type: image/png` with an EXE body
 * satisfies it perfectly.
 *
 * Hand-rolled: three patterns over at most 12 bytes. `file-type` is not worth a dependency for this.
 */

export const AVATAR_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AvatarImageType = (typeof AVATAR_IMAGE_TYPES)[number];

export const isAvatarImageType = (value: string): value is AvatarImageType =>
  (AVATAR_IMAGE_TYPES as readonly string[]).includes(value);

const startsWith = (buffer: Buffer, bytes: readonly number[]): boolean =>
  buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);

/** JPEG: `FF D8 FF`. */
const isJpeg = (b: Buffer): boolean => startsWith(b, [0xff, 0xd8, 0xff]);

/** PNG: `89 50 4E 47 0D 0A 1A 0A`. */
const isPng = (b: Buffer): boolean =>
  startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** WEBP: `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` — "RIFF" …size… "WEBP". */
const isWebp = (b: Buffer): boolean =>
  b.length >= 12 &&
  b.toString('ascii', 0, 4) === 'RIFF' &&
  b.toString('ascii', 8, 12) === 'WEBP';

/** The type the BYTES actually are, or `null` if they are not one of the three allowed images. */
export function sniffImageType(buffer: Buffer): AvatarImageType | null {
  if (isJpeg(buffer)) return 'image/jpeg';
  if (isPng(buffer)) return 'image/png';
  if (isWebp(buffer)) return 'image/webp';
  return null;
}
