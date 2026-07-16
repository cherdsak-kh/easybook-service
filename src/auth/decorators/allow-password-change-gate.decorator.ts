import { SetMetadata } from '@nestjs/common';

export const ALLOW_PASSWORD_CHANGE_GATE = 'allowPasswordChangeGate';

/**
 * Exempts a handler from the forced-reset gate enforced inside `SessionGuard` (AC-B8).
 *
 * **Polarity: deny by default, opt out explicitly.** A future route added without thought is
 * BLOCKED (a visible, reported bug) rather than OPEN (a silent hole). That is the whole reason this
 * is a decorator on three handlers rather than a blocklist of everything else.
 *
 * The exempt set is EXACTLY: `POST /auth/system/logout`, `GET /auth/system/me`,
 * `POST /auth/system/password`. (`GET /auth/system/csrf`, `POST /auth/system/login` and
 * `GET /health` need no decorator — they have no `SessionGuard` at all.)
 *
 * Do NOT add this to `PATCH /auth/system/me` or `POST /auth/system/me/avatar`: editing your name or
 * avatar is not a prerequisite for escaping the gate. Widening this set wrongly is either a
 * permanent lockout (if the reset door is closed) or a hole (if everything is open).
 */
export const AllowPasswordChangeGate = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_GATE, true);
