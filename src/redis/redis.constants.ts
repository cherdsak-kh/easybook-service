/** Injection token for the shared `ioredis` client. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/** Session store key prefix. Disjoint from the throttle prefixes (§3.3). */
export const SESSION_KEY_PREFIX = 'eb:sess:';
