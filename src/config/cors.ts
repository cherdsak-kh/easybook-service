import type { ConfigService } from '@nestjs/config';

/** The dev-server origin `CORS_ORIGIN` falls back to when unset. */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:2200';

/**
 * THE one parse of `CORS_ORIGIN`.
 *
 * Extracted out of `app.setup.ts` so the HTTP layer (`app.enableCors`) and the Socket.IO layer
 * (`SessionIoAdapter`'s `cors` + `originGuard`) provably share **one** allowlist. A second inline
 * parse is how the socket and the REST surface would drift into disagreeing about who may talk to
 * this backend.
 *
 * `*` never appears here and never can: `validateEnv` rejects `CORS_ORIGIN === '*'` in production,
 * and that check now covers the socket for free. A comma-separated value (the Vite dev server plus
 * a tunnel used for on-device LIFF testing) becomes an array of trimmed origins.
 */
export function resolveCorsOrigin(config: ConfigService): string | string[] {
  const raw = config.get<string>('CORS_ORIGIN', DEFAULT_CORS_ORIGIN);
  return raw.includes(',')
    ? raw.split(',').map((origin) => origin.trim())
    : raw;
}

/** `resolveCorsOrigin`'s result as an array, for membership tests. */
export const asOriginList = (allowlist: string | string[]): string[] =>
  Array.isArray(allowlist) ? allowlist : [allowlist];
