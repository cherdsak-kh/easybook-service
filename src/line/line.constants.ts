/**
 * LINE Messaging API limits and timings used by `LineService` (`ANNOUNCE-API-2`).
 *
 * Every number here is either LINE's documented hard limit or a deadline chosen so a hung request
 * cannot hold the announcement row lock until the transaction times out (design S-2).
 */

/** LINE's cap on `to` per multicast request. A larger array is a 400 for the WHOLE request. */
export const LINE_MULTICAST_MAX_RECIPIENTS = 500;

/** LINE's cap on `messages` per request. */
export const LINE_MULTICAST_MAX_MESSAGES = 5;

/**
 * One multicast ATTEMPT. The SDK has no timeout, no `AbortSignal` and no fetch hook, so this is a
 * `Promise.race`. A timed-out request may still land at LINE; the retry reuses the same
 * `X-Line-Retry-Key`, so LINE answers 409 and it counts as accepted.
 */
export const LINE_CALL_TIMEOUT_MS = 15_000;

/** `GET /v2/bot/info` — one cheap read when the admin screen loads. */
export const LINE_BOT_INFO_TIMEOUT_MS = 5_000;

/**
 * The UUID v5 namespace every `X-Line-Retry-Key` is derived in.
 *
 * 🔴 NEVER CHANGE IT. It is part of every key: a new namespace makes every retry key new, so a resend
 * inside LINE's 24 h window would deliver twice instead of answering 409.
 */
export const LINE_RETRY_KEY_NAMESPACE = '3f6c2a4e-8b1d-4c7a-9e05-6d2b7f1a9c34';

/**
 * A well-formed LINE user id: `U` + 32 lowercase hex (design S-5).
 *
 * LINE answers a multicast holding ONE invalid id with a 400 for the whole request, so an announcement
 * skips a malformed id rather than letting it sink every recipient in its chunk. Production rows come
 * from follow webhooks and always match.
 */
export const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
