/** Injection token for the shared `ioredis` client. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/** Session store key prefix. Disjoint from the throttle prefixes (§3.3). */
export const SESSION_KEY_PREFIX = 'eb:sess:';

/**
 * Cache-aside keyspace. Disjoint from `eb:sess:` and `eb:throttle:`, and applied by
 * `RedisService` itself so no caller can address a key outside it.
 *
 * That containment is the point, not tidiness: the cache's write path is a `DEL`, and a `DEL`
 * that could reach `eb:sess:*` would log every operator out of the system. The session store is
 * the app's only piece of state with no source of truth behind it — everything under this prefix
 * is reconstructible from PostgreSQL, and nothing under `eb:sess:` is.
 */
export const CACHE_KEY_PREFIX = 'eb:cache:';

/**
 * TTL for every cache key — **300 seconds, no exceptions** (R4).
 *
 * It is the safety net under every missed `DEL`, which is why it is one constant with no
 * per-key override: a key that outlives its invalidation is a wrong answer that nothing else in
 * the system will ever come along and fix.
 */
export const CACHE_TTL_SECONDS = 300;

/**
 * Notification throttle markers (C1/C5, `NOTIF-EVENTS-1` design §2.6). A DISJOINT keyspace from
 * `eb:cache:` on purpose: the cache's "300s, no exceptions, DEL-reachable, reconstructible from PG"
 * rule describes a read-through cache, not a "did we already alert on this in the last N minutes"
 * throttle marker — the two have different TTLs (3600s / 900s) and are never invalidated by a write.
 * Flagged for PO in the plan (Q-8); the default is to keep it disjoint rather than reuse `eb:cache:`.
 */
export const NOTIF_KEY_PREFIX = 'eb:notif:';

/**
 * Per-user index of live session ids (LOGIN-SESSIONS-1): `eb:user-sessions:<SystemUser.id>` → Set<sid>.
 * DISJOINT from `eb:sess:` on purpose: connect-redis SCANs `eb:sess:*` for ids()/all()/length()/clear(), and a Set
 * there would be returned as a fake sid and WRONGTYPE-fail `all()`'s MGET. Disjoint from `eb:cache:` because the
 * cache's write path is a DEL reachable by any caller. Written ONLY through `SessionTrackerService` on the raw client.
 * Members are raw sids, i.e. bearer secrets: never log, return or KEYS/SCAN this family in app code.
 */
export const SESSION_INDEX_KEY_PREFIX = 'eb:user-sessions:';
export const sessionIndexKey = (systemUserId: string): string =>
  `${SESSION_INDEX_KEY_PREFIX}${systemUserId}`;
