import type { Request } from 'express';
import type { PublicSystemUser } from '../system-users/system-users.fields';
import '../session/session.types';

/**
 * The user attached to a request by `SessionGuard` — a fresh DB read (D-9), already stripped of
 * `deletedAt`. Exactly `SystemUserResponseDto`'s shape, with `Date`s not ISO strings.
 */
export type AuthenticatedSystemUser = PublicSystemUser;

export interface RequestWithSystemUser extends Request {
  systemUser?: AuthenticatedSystemUser;
}
