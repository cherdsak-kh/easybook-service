import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import './session.types';

const logger = new Logger('Session');

const SESSION_STORE_UNAVAILABLE = 'Session store unavailable.';

/**
 * Rotates the session id, discarding the old Redis key.
 *
 * MUST run **before** the session payload is assigned — `regenerate()` wipes session data.
 * This is the session-fixation defence (AC-8).
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) =>
      error ? reject(toStoreError(error)) : resolve(),
    );
  });
}

/**
 * Explicitly persists the session.
 *
 * Relying on the implicit save at response end would let a Redis failure silently lose the
 * session while the handler still answered `200`. Awaiting it here is what surfaces a store
 * outage as `503` (AC-13).
 */
export function saveSession(req: Request): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    req.session.save((error) =>
      error ? reject(toStoreError(error)) : resolve(),
    );
  });
}

/** Destroys the session, removing its Redis key (AC-12). */
export function destroySession(req: Request): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    req.session.destroy((error) =>
      error ? reject(toStoreError(error)) : resolve(),
    );
  });
}

/**
 * Best-effort destroy used by `SessionGuard` when it rejects a stale session.
 *
 * The caller is already returning `401`; a store failure here must not turn that into a `503`,
 * and the orphaned key authenticates nothing (its holder is deleted, suspended, or gone).
 */
export async function destroySessionQuietly(req: Request): Promise<void> {
  if (!req.session) return;
  try {
    await destroySession(req);
  } catch (error) {
    logger.warn(
      `Failed to destroy a rejected session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const toStoreError = (error: unknown): ServiceUnavailableException => {
  logger.error(
    `Session store failure: ${error instanceof Error ? error.message : String(error)}`,
  );
  return new ServiceUnavailableException(SESSION_STORE_UNAVAILABLE);
};
