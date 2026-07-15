/**
 * Boot-time environment validation (T-6).
 *
 * Wired as `ConfigModule.forRoot({ validate: validateEnv })`, so a throw here aborts boot.
 * That is correct and is NOT a contradiction of the "Redis must not crash-loop" rule: a
 * misconfigured secret is a deploy defect that must never start, whereas an unreachable Redis
 * is a transient runtime condition that degrades to 503.
 */

/** Documented dev placeholders. Present in `.env.example`; never valid in production. */
export const DEV_SESSION_SECRET_PLACEHOLDER =
  'dev-only-session-secret-change-me';
export const DEV_CSRF_SECRET_PLACEHOLDER = 'dev-only-csrf-secret-change-me';

const MIN_SECRET_LENGTH = 32;
const SAME_SITE_VALUES = ['lax', 'strict', 'none'] as const;

export type SameSite = (typeof SAME_SITE_VALUES)[number];

const str = (raw: Record<string, unknown>, key: string): string | undefined => {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** `SESSION_COOKIE_SECURE` is a string env var; only the literal `'true'` enables it. */
export const isCookieSecure = (rawValue: string | undefined): boolean =>
  rawValue?.trim().toLowerCase() === 'true';

/** Normalises `SESSION_COOKIE_SAMESITE`, defaulting to `lax`. */
export const resolveSameSite = (rawValue: string | undefined): SameSite => {
  const value = rawValue?.trim().toLowerCase();
  return (SAME_SITE_VALUES as readonly string[]).includes(value ?? '')
    ? (value as SameSite)
    : 'lax';
};

export function validateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];

  // 1. Redis is a hard dependency of the session store. Its URL must exist at boot even
  //    though the server itself may be down (§3.2).
  if (!str(raw, 'REDIS_URL')) {
    errors.push('REDIS_URL is required.');
  }

  // 1b. LINE Login channel id — the `aud` an ID token is minted for (LineIdTokenGuard). DISTINCT
  //     from the Messaging API channel (LINE_CHANNEL_ACCESS_TOKEN/_SECRET). When present in any
  //     environment it must be the numeric Login channel id (digits only); it is required in
  //     production (§2.4). In dev/test the guard throws a request-time 500 if unset, so a developer
  //     not exercising LINE auth still boots — mirroring LineService's stance on the Messaging token.
  const lineLoginChannelId = str(raw, 'LINE_LOGIN_CHANNEL_ID');
  if (lineLoginChannelId !== undefined && !/^\d+$/.test(lineLoginChannelId)) {
    errors.push(
      'LINE_LOGIN_CHANNEL_ID must be a numeric channel id (digits only).',
    );
  }

  const sessionSecret = str(raw, 'SESSION_SECRET');
  const csrfSecret = str(raw, 'CSRF_SECRET');
  const cookieSecureRaw = str(raw, 'SESSION_COOKIE_SECURE');
  const sameSiteRaw = str(raw, 'SESSION_COOKIE_SAMESITE')?.toLowerCase();
  const cookieSecure = isCookieSecure(cookieSecureRaw);

  // 2. Production hardening.
  if (str(raw, 'NODE_ENV') === 'production') {
    const secrets: Array<[string, string | undefined, string]> = [
      ['SESSION_SECRET', sessionSecret, DEV_SESSION_SECRET_PLACEHOLDER],
      ['CSRF_SECRET', csrfSecret, DEV_CSRF_SECRET_PLACEHOLDER],
    ];
    for (const [name, value, placeholder] of secrets) {
      if (!value) errors.push(`${name} is required in production.`);
      else if (value.length < MIN_SECRET_LENGTH) {
        errors.push(
          `${name} must be at least ${MIN_SECRET_LENGTH} characters in production.`,
        );
      } else if (value === placeholder) {
        errors.push(
          `${name} must not be the documented dev placeholder in production.`,
        );
      }
    }

    if (sessionSecret && csrfSecret && sessionSecret === csrfSecret) {
      errors.push('SESSION_SECRET and CSRF_SECRET must be distinct values.');
    }

    if (!cookieSecure) {
      errors.push('SESSION_COOKIE_SECURE must be "true" in production.');
    }

    // With `credentials: true`, the CORS allowlist is a security control, not a convenience.
    const corsOrigin = str(raw, 'CORS_ORIGIN');
    if (!corsOrigin || corsOrigin === '*') {
      errors.push(
        'CORS_ORIGIN must be an explicit origin in production (never "*").',
      );
    }

    // The LINE-consumer auth surface must not silently 500 in production.
    if (!lineLoginChannelId) {
      errors.push('LINE_LOGIN_CHANNEL_ID is required in production.');
    }
  }

  // 3. Browsers reject `SameSite=None` without `Secure` outright — fail in any environment.
  if (sameSiteRaw === 'none' && !cookieSecure) {
    errors.push(
      'SESSION_COOKIE_SAMESITE="none" requires SESSION_COOKIE_SECURE="true".',
    );
  }
  if (
    sameSiteRaw &&
    !(SAME_SITE_VALUES as readonly string[]).includes(sameSiteRaw)
  ) {
    errors.push(
      `SESSION_COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(' | ')}.`,
    );
  }

  // 4. A non-positive TTL would mint already-expired cookies.
  const ttlRaw = str(raw, 'SESSION_TTL_SECONDS');
  if (ttlRaw !== undefined) {
    const ttl = Number(ttlRaw);
    if (!Number.isInteger(ttl) || ttl <= 0) {
      errors.push('SESSION_TTL_SECONDS must be a positive integer.');
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n  - ${errors.join('\n  - ')}`,
    );
  }

  return raw;
}
