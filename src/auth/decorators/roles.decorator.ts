import { SetMetadata } from '@nestjs/common';
import type { SystemRole } from '@prisma/client';

export const ROLES_KEY = 'systemRoles';

/**
 * The **coarse** role gate read by `RolesGuard`.
 *
 * It never encodes target-dependent rules ("an ADMIN may only patch a STAFF") — those need the
 * target row and live in `system-users.policy.ts`, inside the write's transaction (DD-8).
 */
export const Roles = (...roles: SystemRole[]) => SetMetadata(ROLES_KEY, roles);
