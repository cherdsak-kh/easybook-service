import { ApiProperty } from '@nestjs/swagger';

/**
 * The `SystemUser` who created this row — audit provenance, nothing more.
 *
 * **Resolved WITHOUT a `deletedAt` filter, and that omission is load-bearing (DD-4).** `createdById`
 * is HISTORY, not an identity read: a soft-deleted creator must keep resolving their name for the
 * rows they created, forever. The nested `select` in `PUBLIC_FIELDS` therefore carries no `where`,
 * and the creator must never be resolved by a second `findFirst({ id, deletedAt: null })` — that
 * filter is the correct idiom everywhere ELSE in this service and is wrong here.
 *
 * `null` only for the seeded first SUPER_ADMIN, whose `createdById` is null (`create()` stamps
 * `createdById: actor.id` on every other row).
 *
 * **Deliberately carries no `email` and no `role`.** An `email` is a login identifier, and exposing
 * an admin's to every STAFF user who reads their own `/auth/system/me` is a targeted-phishing
 * surface; `role` tells a STAFF user which colleague is a SUPER_ADMIN, which is reconnaissance with
 * zero UI use. `deletedAt`, `isActive` and `profilePictureUrl` are excluded too — the first by the
 * standing AC-32 rule, the rest for want of a consumer.
 *
 * A nested object rather than a flat `createdByName: string`: name composition is a client concern
 * (the same precedent `department` / `personnelRole` already set with `{ id, name }`), `id` makes
 * the row linkable later at zero cost, and `null` is unambiguous on an object where a flat string
 * would invite an empty-string sentinel.
 */
export class SystemUserCreatorDto {
  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  id!: string;

  @ApiProperty({ example: 'Somsri' })
  firstName!: string;

  @ApiProperty({ example: 'Systemadmin' })
  lastName!: string;
}
