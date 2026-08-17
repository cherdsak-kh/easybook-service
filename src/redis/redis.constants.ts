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
