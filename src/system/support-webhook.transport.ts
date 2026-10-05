import { Injectable } from '@nestjs/common';

/**
 * THE ONLY place that calls `fetch` for the support relay, and the seam tests replace (design §2.10).
 * `SupportRelayService` depends on this abstract class token, never on `fetch`.
 *
 * Contract: resolves with the upstream HTTP status; rejects on a network error or abort. It never
 * reads or returns the response body. A rejection here may carry the request URL in its message —
 * the caller must NEVER log or re-throw it.
 */
export abstract class SupportWebhookTransport {
  abstract post(url: URL, body: FormData, signal: AbortSignal): Promise<number>;
}

@Injectable()
export class FetchSupportWebhookTransport extends SupportWebhookTransport {
  async post(url: URL, body: FormData, signal: AbortSignal): Promise<number> {
    // No Content-Type header: fetch sets the multipart boundary itself.
    const res = await fetch(url, { method: 'POST', body, signal });
    // Free the socket. The body is never read, logged or returned.
    await res.body?.cancel();
    return res.status;
  }
}
