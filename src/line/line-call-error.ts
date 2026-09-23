import { HTTPFetchError } from '@line/bot-sdk';

/**
 * How a failed LINE call is classified (`ANNOUNCE-API-2`, design §1.2). Pure — no Nest, no I/O.
 *
 * - `NOT_CONFIGURED`   no Messaging client (no token), or HTTP 401 / 403.
 * - `RATE_LIMITED`     HTTP 429 — a rate limit OR the monthly message quota.
 * - `ALREADY_ACCEPTED` HTTP 409 — meaningful only on a request that carried `X-Line-Retry-Key`: LINE
 *                      already accepted that exact request.
 * - `TRANSIENT`        network error, HTTP >= 500, a per-call timeout, the send deadline, or a 2xx
 *                      whose body did not parse. Worth one retry with the same key.
 * - `REJECTED`         any other HTTP 4xx (400 invalid payload or ids, 413, …).
 */
export type LineErrorKind =
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'ALREADY_ACCEPTED'
  | 'TRANSIENT'
  | 'REJECTED';

/**
 * The only error shape a LINE failure leaves `LineService` as.
 *
 * 🔴 ITS MESSAGE NEVER CARRIES LINE'S RESPONSE BODY. `HTTPFetchError.body` is LINE's raw JSON, and its
 * `details[].property` can name `to[n]` — a recipient. Kind and status are all anyone needs.
 */
export class LineCallError extends Error {
  constructor(
    readonly kind: LineErrorKind,
    readonly status: number | null,
  ) {
    super(`LINE call failed: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'LineCallError';
  }
}

/** Maps anything a LINE SDK call can reject with onto a {@link LineCallError}, in this order. */
export function classifyLineError(err: unknown): LineCallError {
  if (err instanceof LineCallError) return err;
  if (err instanceof HTTPFetchError) {
    const { status } = err;
    if (status === 401 || status === 403) {
      return new LineCallError('NOT_CONFIGURED', status);
    }
    if (status === 429) return new LineCallError('RATE_LIMITED', status);
    if (status === 409) return new LineCallError('ALREADY_ACCEPTED', status);
    if (status >= 500) return new LineCallError('TRANSIENT', status);
    return new LineCallError('REJECTED', status);
  }
  // `TypeError: fetch failed`, a `SyntaxError` from the SDK parsing a 2xx body, anything else. A
  // garbled 2xx therefore retries with the same key and comes back 409 → accepted, which is right.
  return new LineCallError('TRANSIENT', null);
}

/**
 * Races `promise` against a timer that rejects with a `TRANSIENT` {@link LineCallError} (design S-2).
 *
 * The abandoned original gets a no-op `catch`, so a rejection that arrives after the timeout can never
 * surface as an unhandled rejection. The timer is always cleared.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LineCallError('TRANSIENT', null)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
