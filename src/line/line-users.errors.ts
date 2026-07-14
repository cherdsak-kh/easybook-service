/**
 * One constant per message, so two branches can never drift apart (mirrors
 * `system-users.errors.ts`).
 *
 * The 404 message is deliberately generic: an unknown id and a soft-deleted id must return a
 * byte-identical body, revealing nothing about deletion (design §3.2, AC-B10).
 */
export const LINE_USER_NOT_FOUND = 'LINE user not found.';
