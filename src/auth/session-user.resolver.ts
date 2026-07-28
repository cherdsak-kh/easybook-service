import { PrismaService } from '../prisma/prisma.service';
import {
  PUBLIC_FIELDS,
  type PublicSystemUser,
} from '../system-users/system-users.fields';
import { SESSION_ABSOLUTE_MAX_AGE_MS } from './auth.constants';

/** Why a session payload did not resolve to a live `SystemUser`. */
export type SessionRejection =
  /** No session, or no `systemUserId` on it. */
  | 'NO_SESSION'
  /** Past `SESSION_ABSOLUTE_MAX_AGE_MS`, measured from `session.createdAt`. */
  | 'SESSION_EXPIRED'
  /** The session points at a row that is gone. */
  | 'USER_NOT_FOUND'
  /** `deletedAt != null` **or** `isActive === false` — checked independently. */
  | 'USER_REVOKED';

export type SessionResolution =
  | { ok: true; user: PublicSystemUser }
  | { ok: false; reason: SessionRejection };

/** The only two session keys either transport reads. */
export interface SessionPayload {
  systemUserId?: string;
  createdAt?: number;
}

/** The subset of `PrismaService` this resolver touches — keeps unit mocks honest. */
type SystemUserReader = Pick<PrismaService, 'systemUser'>;

/**
 * THE one definition of "does this session payload resolve to a live `SystemUser`".
 *
 * Extracted from `SessionGuard` so HTTP and the WebSocket handshake share **one** implementation
 * rather than the parallel auth path `CLAUDE.md` forbids. The order below is byte-for-byte the
 * order `SessionGuard` has always used, and its spec is the regression net for that.
 *
 * **Pure with respect to the session store.** It NEVER destroys, saves or touches a session — the
 * caller owns that side effect. `SessionGuard` destroys on rejection; the realtime gateway
 * deliberately does not, so a socket can neither resurrect, extend, nor destroy a session.
 *
 * `mustChangePassword` is deliberately **not** applied here: on HTTP it is decorator-gated
 * (`@AllowPasswordChangeGate`), on the socket it is unconditional. Each caller applies its own
 * policy to the returned user.
 */
export async function resolveSessionUser(
  prisma: SystemUserReader,
  session: SessionPayload | undefined,
): Promise<SessionResolution> {
  const systemUserId = session?.systemUserId;
  if (!systemUserId) {
    return { ok: false, reason: 'NO_SESSION' };
  }

  // Absolute cap, independent of the rolling idle window.
  if (Date.now() - (session?.createdAt ?? 0) > SESSION_ABSOLUTE_MAX_AGE_MS) {
    return { ok: false, reason: 'SESSION_EXPIRED' };
  }

  return resolveSystemUserById(prisma, systemUserId);
}

/**
 * The DB half of `resolveSessionUser`, callable on its own by the realtime revalidation sweep —
 * which holds a `systemUserId` captured at handshake and has already verified the session key
 * separately against the store.
 *
 * `deletedAt` is **selected in order to be checked, then stripped**: a soft-deleted user is
 * normally still `isActive: true`, so checking `isActive` alone would authenticate a deleted
 * account holding a live cookie — and leaving `deletedAt` on the returned object would leak it
 * into `GET /auth/system/me`'s body. Both flags are checked independently; they are orthogonal.
 */
export async function resolveSystemUserById(
  prisma: SystemUserReader,
  systemUserId: string,
): Promise<SessionResolution> {
  const user = await prisma.systemUser.findUnique({
    where: { id: systemUserId },
    select: { ...PUBLIC_FIELDS, deletedAt: true },
  });

  if (!user) {
    return { ok: false, reason: 'USER_NOT_FOUND' };
  }

  const { deletedAt, ...publicUser } = user;
  if (deletedAt !== null || !publicUser.isActive) {
    return { ok: false, reason: 'USER_REVOKED' };
  }

  return { ok: true, user: publicUser };
}
