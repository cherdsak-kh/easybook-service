import {
  AdminNotificationTargetRole,
  Prisma,
  SystemRole,
} from '@prisma/client';

/**
 * `NOTIF-API-1` — WHO SEES WHICH NOTIFICATION. Pure: no Prisma client, no I/O (design §6.1).
 *
 * 🔴 EVERY query in `NotificationsService` — list, count and all four mutations — starts from
 * {@link visibleTo}. That is the whole defence against plan R-1 (one method forgetting the filter and
 * counting or dismissing a SUPER_ADMIN-only row for an ADMIN). The one raw statement (read-all) cannot
 * call it, so it reads {@link VISIBLE_TARGET_ROLES} directly — the same constant, never a copy.
 */

/**
 * `targetRole` is the MINIMUM role, read as "this role and above": SUPER_ADMIN > ADMIN > VIEWER (D-2).
 *
 * A `Record<SystemRole, …>`: adding a `SystemRole` member fails the build HERE until someone decides
 * what the new role may see. That is deliberate — defaulting a new role to "everything" or to
 * "nothing" would both be silent decisions.
 */
export const VISIBLE_TARGET_ROLES: Record<
  SystemRole,
  readonly AdminNotificationTargetRole[]
> = {
  SUPER_ADMIN: [
    AdminNotificationTargetRole.ALL,
    AdminNotificationTargetRole.ADMIN,
    AdminNotificationTargetRole.SUPER_ADMIN,
  ],
  ADMIN: [AdminNotificationTargetRole.ALL, AdminNotificationTargetRole.ADMIN],
  VIEWER: [AdminNotificationTargetRole.ALL],
};

/**
 * The caller, from `@CurrentUser()` ONLY — `SessionGuard` re-reads the role on every request, so a
 * demoted operator loses visibility on their next call. No DTO field can name a user or a role.
 */
export interface NotificationCaller {
  id: string;
  role: SystemRole;
}

/** Role-visible AND not dismissed by the caller. Every read and every mutation starts from this. */
export const visibleTo = (
  caller: NotificationCaller,
): Prisma.AdminNotificationWhereInput => ({
  targetRole: { in: [...VISIBLE_TARGET_ROLES[caller.role]] },
  receipts: { none: { systemUserId: caller.id, dismissedAt: { not: null } } },
});

/**
 * Unread for this operator. "No receipt row = unread" is expressed as NONE-with-readAt, never as
 * SOME-with-readAt-null — the latter would miss every notification the operator never touched, which
 * is almost all of them (D-1).
 */
export const unreadFor = (
  userId: string,
): Prisma.AdminNotificationWhereInput => ({
  receipts: { none: { systemUserId: userId, readAt: { not: null } } },
});

/** Read by this operator: a receipt row exists AND carries a `readAt`. */
export const readFor = (
  userId: string,
): Prisma.AdminNotificationWhereInput => ({
  receipts: { some: { systemUserId: userId, readAt: { not: null } } },
});

/**
 * 🔴 THE ONLY WAY TO COMBINE THE BUILDERS ABOVE. `visibleTo` and `unreadFor`/`readFor` all set the
 * `receipts` key, so `{ ...visibleTo(c), ...unreadFor(c.id) }` would silently DROP the dismissal filter
 * and dismissed rows would reappear in the unread list. `AND: [...]` keeps every clause.
 */
export const allOf = (
  ...clauses: Prisma.AdminNotificationWhereInput[]
): Prisma.AdminNotificationWhereInput => ({ AND: clauses });
