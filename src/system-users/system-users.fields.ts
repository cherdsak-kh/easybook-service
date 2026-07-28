import type { Prisma } from '@prisma/client';
import { SystemUserResponseDto } from './dto/system-user-response.dto';

/**
 * THE one definition of "a publicly visible SystemUser".
 *
 * Imported by `SessionGuard` and `SystemUsersService` alike so the two can never drift.
 * It omits the password digest (AC-5) and it omits `deletedAt` (AC-32) — `SessionGuard` selects
 * `deletedAt` separately, checks it, and strips it before attaching the user to the request.
 *
 * The two nested option selects carry **NO `deletedAt` filter**, and that omission is deliberate and
 * load-bearing (AC-B4): a soft-deleted `Department`/`PersonnelRole` must still resolve its name for
 * an existing assignment, forever. Adding `where: { deletedAt: null }` would make the relation return
 * `null` against a non-nullable DTO field and 500 the list. This is the read half of the asymmetry —
 * READS ignore `deletedAt`, WRITES require an ACTIVE option (validated in the service → 400). Same
 * contract as the LINE registration embed.
 *
 * `mustChangePassword` rides along here rather than in a per-endpoint variant: `PUBLIC_FIELDS` is the
 * single shared select that keeps `SessionGuard` and `SystemUsersService` from drifting, and it is
 * what lets the forced-reset gate reuse the row `SessionGuard` already read (zero extra queries).
 *
 * `createdBy` rides along for the same reason, and there was no alternative: `GET /auth/system/me`
 * is `toSystemUserDto(req.systemUser)` and issues NO query of its own, so the only way it can serve
 * a creator is for `SessionGuard`'s select — which is `{ ...PUBLIC_FIELDS, deletedAt: true }` — to
 * carry it. A per-route variant would mean a second DB read inside the controller, i.e. exactly the
 * drift this file exists to prevent. The price is one extra primary-key relation resolve per
 * authenticated request; on the paginated list Prisma batches it into ONE follow-up query for the
 * whole page (`WHERE id IN (…)`), never one per row, so there is no N+1 — do not "optimise" it into
 * a manual `id IN (...)` fetch plus an in-memory join.
 *
 * The `createdBy` select carries **NO filter of any kind and must never acquire one** (DD-4).
 * `createdById` is HISTORY, not an identity read: a SOFT-DELETED creator must still resolve. So:
 * never add `where: { deletedAt: null }` here; never resolve the creator with a second
 * `findFirst({ where: { id: createdById, deletedAt: null } })` (that filter is the correct idiom
 * everywhere else in this service and is WRONG here); and never select the raw `createdById`
 * alongside it — the nested object already carries `id`, and a raw FK would be a second,
 * unspecified field in the emitted OpenAPI schema.
 */
export const PUBLIC_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  department: { select: { id: true, name: true } }, // NO deletedAt filter — AC-B4
  personnelRole: { select: { id: true, name: true } }, // NO deletedAt filter — AC-B4
  phoneNumber: true,
  profilePictureUrl: true,
  mustChangePassword: true,
  isActive: true,
  lastLoginAt: true,
  lineUserId: true,
  createdAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } }, // NO where — DD-4
  updatedAt: true,
} as const;

/** A `SystemUser` row narrowed to `PUBLIC_FIELDS`. Dates are still `Date`s. */
export type PublicSystemUser = Prisma.SystemUserGetPayload<{
  select: typeof PUBLIC_FIELDS;
}>;

/** Serialises a `PublicSystemUser` into the wire contract (ISO 8601 timestamps). */
export function toSystemUserDto(row: PublicSystemUser): SystemUserResponseDto {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    department: { id: row.department.id, name: row.department.name },
    personnelRole: {
      id: row.personnelRole.id,
      name: row.personnelRole.name,
    },
    mustChangePassword: row.mustChangePassword,
    phoneNumber: row.phoneNumber,
    profilePictureUrl: row.profilePictureUrl,
    isActive: row.isActive,
    lineUserId: row.lineUserId,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // Rebuilt field by field, exactly as `department`/`personnelRole` are — never a spread, so a
    // future widening of the nested select cannot silently reach the wire.
    createdBy: row.createdBy
      ? {
          id: row.createdBy.id,
          firstName: row.createdBy.firstName,
          lastName: row.createdBy.lastName,
        }
      : null,
    // `updatedAt` is `DateTime @updatedAt`, i.e. NOT NULL and populated on create as well as on
    // update — never null, so no `? :` branch, unlike `lastLoginAt`.
    updatedAt: row.updatedAt.toISOString(),
  };
}
