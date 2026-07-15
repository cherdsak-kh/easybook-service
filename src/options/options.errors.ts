/** One constant per message, so two branches can never drift apart (mirrors `system-users.errors.ts`). */

/**
 * A create/rename collided with an ACTIVE (non-deleted) option name — mapped from the partial-unique
 * index's `P2002` (SC-4). Creating a name that exists only among soft-deleted rows succeeds, so this
 * is specifically the active-name collision.
 */
export const OPTION_NAME_TAKEN = 'An option with this name already exists.';

/**
 * Generic 404 for `PATCH`/`DELETE` on an unknown or already-soft-deleted option id — byte-identical
 * for both (the target read filters `deletedAt: null`), revealing nothing about deletion.
 */
export const OPTION_NOT_FOUND = 'Option not found.';
