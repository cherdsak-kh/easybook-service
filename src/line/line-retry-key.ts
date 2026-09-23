import { createHash } from 'node:crypto';
import { LINE_RETRY_KEY_NAMESPACE } from './line.constants';

/**
 * The `X-Line-Retry-Key` for one multicast chunk (`ANNOUNCE-API-2`, D-B, design §1.6).
 *
 * Deterministic: the same seed and the same members give the same key, whatever order the members
 * arrive in (they are sorted FOR HASHING ONLY — the request keeps the caller's order). A different
 * seed or one different member gives a different key. LINE answers a repeat of an accepted key with
 * 409 for 24 h, which is what makes a resend after a total failure safe.
 *
 * The announcements caller seeds with `${id}|${updatedAt ISO}`, so an edit mints new keys.
 */
export function lineRetryKey(seed: string, chunk: readonly string[]): string {
  return uuidV5(
    LINE_RETRY_KEY_NAMESPACE,
    `${seed}|${[...chunk].sort().join(',')}`,
  );
}

/**
 * RFC 4122 name-based UUID, version 5 (SHA-1). No dependency: `crypto.randomUUID` is v4 only, and
 * the repo has no `uuid` package.
 */
export function uuidV5(namespace: string, name: string): string {
  const b = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
