import { createHash } from 'node:crypto';
import type { Request } from 'express';

/**
 * The Redis key builders for the two login rate limits.
 *
 * Imported by **both** `LoginThrottleGuard` (which writes the counters) and `AuthService` (which
 * clears the per-email counter on a successful login, AC-21), so the two can never drift.
 *
 * Prefixes are disjoint from the session store's `eb:sess:`, so a `DEL eb:throttle:*` can never
 * touch a session.
 */

export const LOGIN_IP_EMAIL_THROTTLER = 'login-ip-email';
export const LOGIN_IP_THROTTLER = 'login-ip';

export const normaliseEmail = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

export const loginIpKey = (ip: string): string => `eb:throttle:login:ip:${ip}`;

/** The email is hashed, never stored plaintext — Redis holds no PII. */
export const loginIpEmailKey = (ip: string, email: string): string =>
  `eb:throttle:login:ip-email:${createHash('sha256')
    .update(`${ip}|${email}`)
    .digest('hex')
    .slice(0, 32)}`;

/**
 * Behind a reverse proxy `req.ip` is the proxy's address and both limits collapse into one
 * bucket. Fixing that needs `app.set('trust proxy', …)` driven by a deployment-owned env var —
 * a `devops` concern (TRUST-PROXY), not a code defect here.
 */
export const resolveIp = (req: Pick<Request, 'ip' | 'ips'>): string =>
  (req.ips?.length ? req.ips[0] : req.ip) ?? 'unknown';
