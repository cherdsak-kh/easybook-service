import type { OptionModel } from '../options/options.service';

/**
 * EVERY cache key in the system, in one file.
 *
 * A key is a contract between a read that fills it and a set of writes that drop it, and those
 * two live in different modules — often in different modules from each other. Spelling the key
 * inline at both ends is how a rename invalidates half the call sites and nothing tells you: the
 * cache does not error, it just answers with last week's data until the TTL expires.
 *
 * ⚠️ THE INVALIDATION ASYMMETRY, which is what makes the call sites below safe to eyeball:
 * dropping a key that did not need dropping costs exactly one cache miss. FAILING to drop one
 * costs a wrong answer for up to 300 seconds, on a screen where nobody will connect the two.
 * So when in doubt, drop it — over-invalidating is cheap and under-invalidating is the bug that
 * arrives as "ทำไมหน้าจอยังขึ้นชื่อเก่า" three days later.
 */

/**
 * The admin option list, keyed by the ONE dimension its result depends on: whether the caller
 * may see system-reserved rows.
 *
 * `includeReserved` is the same boolean that builds the WHERE clause — the caller passes the one
 * it is about to query with, so the key and the filter cannot drift apart. That is the structural
 * form of "the caller's role must be in the key" (R3): here the role has already collapsed to
 * `mayUseSystemReservedOptions`, so the keyspace is 2 views per table, not one per role and not
 * one per user.
 *
 * Getting this wrong is not a performance bug. A key without this dimension serves a SUPER_ADMIN's
 * view — reserved rows included — to the next ADMIN who asks, and it would never show up in a
 * test run under a single account.
 */
export const optionListKey = (
  model: OptionModel,
  includeReserved: boolean,
): string =>
  `opt:${model === 'department' ? 'dept' : 'role'}:${includeReserved ? 'reserved' : 'plain'}`;

/**
 * The four admin option keys. Dropped by anything that can move a `holderCount` — which is a much
 * wider set than "somebody edited an option", because the count is over `SystemUser` and
 * `LineUserRegistration` rows, not over the option table.
 */
export const OPTION_LIST_KEYS: readonly string[] = [
  optionListKey('department', false),
  optionListKey('department', true),
  optionListKey('personnelRole', false),
  optionListKey('personnelRole', true),
];

/**
 * The LIFF registration form's option lists — `{ id, name }` only, never reserved, both tables in
 * one payload.
 *
 * Deliberately NOT derived from the admin keys despite overlapping: it carries no `holderCount`,
 * so it survives every staff and registration write and is dropped only when an option itself
 * changes. Folding it into `OPTION_LIST_KEYS` would evict the hottest read on the LINE surface
 * every time an admin edits a staff member's department.
 */
export const LIFF_OPTIONS_KEY = 'opt:liff';

/** Everything an option write invalidates: the admin views and the LIFF view. */
export const OPTION_CACHE_KEYS: readonly string[] = [
  ...OPTION_LIST_KEYS,
  LIFF_OPTIONS_KEY,
];

/**
 * A LINE user's own status view — the single call the LIFF client makes on open to decide which
 * of the four screens to render.
 *
 * ⚠️ THE ARGUMENT IS THE LINE-SIDE `U…` SUB, NOT THE CUID. `LineUser.id` (cuid) and
 * `LineUser.lineUserId` (`U…`) are both "the line user id" in conversation, and `SystemUser`
 * carries a THIRD field spelled `lineUserId` that holds the cuid. Keying this with a cuid by
 * mistake type-checks perfectly and produces a cache that is simply never hit, and never wrong —
 * so nothing fails, it just quietly stops working. The parameter name is the only guard rail
 * there is; keep it.
 *
 * ⚠️ THE CACHED PAYLOAD CONTAINS PII — the registrant's first name, last name and phone. That
 * makes Redis a second store of personal data with its own 300s retention, alongside the R2
 * avatar bucket, and puts it in `AUTH-ERASURE`'s scope. An erasure that clears PostgreSQL and
 * forgets this key leaves the data readable for up to five more minutes.
 */
export const lineStatusKey = (lineSub: string): string =>
  `line:status:${lineSub}`;

/**
 * "This follower's LINE profile was re-fetched recently" — a cooldown marker for the webhook
 * refresh path, NOT a copy of anything.
 *
 * ⚠️ IT IS WRITTEN FROM A NON-READ PATH, WHICH `RedisService.setJson` OTHERWISE FORBIDS (R4), and
 * the exemption is the point rather than an oversight. That rule exists because a write that fills
 * the cache is a DB-then-Redis pair which cannot be atomic — die between them and Redis serves a
 * stale copy of a row until somebody edits it again. There is no copy here: the value is a
 * throwaway `1`, and the two ways it can be wrong are "we skip one profile refresh" (marker
 * survived a failed fetch) and "we do one extra" (marker lost to a flush). Neither can serve a
 * wrong answer to anybody.
 *
 * ⚠️ THE TTL IS THE STALENESS BUDGET FOR A CHAT-ONLY FOLLOWER. Someone who opens the LIFF is
 * refreshed from their ID token on every cache-missed `GET /line-users/status` — free, no cooldown.
 * This path is the fallback for a follower who only ever chats with the OA, where each refresh
 * costs a real Messaging-API call, so it is deliberately slow.
 */
export const lineProfileSyncKey = (lineSub: string): string =>
  `line:profile-sync:${lineSub}`;

/** How long the marker above suppresses another `getProfile` for the same follower. */
export const LINE_PROFILE_SYNC_TTL_SECONDS = 6 * 60 * 60;
