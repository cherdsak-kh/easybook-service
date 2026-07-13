import type { Prisma } from '@prisma/client';
import { SystemUserResponseDto } from './dto/system-user-response.dto';

/**
 * THE one definition of "a publicly visible SystemUser".
 *
 * Imported by `SessionGuard` and `SystemUsersService` alike so the two can never drift.
 * It omits the password digest (AC-5) and it omits `deletedAt` (AC-32) — `SessionGuard` selects
 * `deletedAt` separately, checks it, and strips it before attaching the user to the request.
 */
export const PUBLIC_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  position: true,
  department: true,
  phoneNumber: true,
  profilePictureUrl: true,
  isActive: true,
  lastLoginAt: true,
  lineUserId: true,
  createdAt: true,
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
    position: row.position,
    department: row.department,
    phoneNumber: row.phoneNumber,
    profilePictureUrl: row.profilePictureUrl,
    isActive: row.isActive,
    lineUserId: row.lineUserId,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
