import { AdminNotificationTargetRole, SystemRole } from '@prisma/client';
import {
  VISIBLE_TARGET_ROLES,
  allOf,
  readFor,
  unreadFor,
  visibleTo,
  type NotificationCaller,
} from './notifications.policy';

const { ALL, ADMIN, SUPER_ADMIN } = AdminNotificationTargetRole;

describe('notifications.policy', () => {
  describe('VISIBLE_TARGET_ROLES (D-2: targetRole is a MINIMUM role)', () => {
    it('SUPER_ADMIN sees ALL, ADMIN and SUPER_ADMIN rows', () => {
      expect([...VISIBLE_TARGET_ROLES[SystemRole.SUPER_ADMIN]].sort()).toEqual(
        [ADMIN, ALL, SUPER_ADMIN].sort(),
      );
    });

    it('ADMIN sees ALL and ADMIN rows — never SUPER_ADMIN', () => {
      expect([...VISIBLE_TARGET_ROLES[SystemRole.ADMIN]].sort()).toEqual(
        [ADMIN, ALL].sort(),
      );
    });

    it('VIEWER sees ALL rows only', () => {
      expect(VISIBLE_TARGET_ROLES[SystemRole.VIEWER]).toEqual([ALL]);
    });

    it('every SystemRole has an entry, and every entry includes ALL', () => {
      for (const role of Object.values(SystemRole)) {
        expect(VISIBLE_TARGET_ROLES[role]).toContain(ALL);
      }
    });
  });

  describe('visibleTo', () => {
    it.each([
      [SystemRole.SUPER_ADMIN, [ALL, ADMIN, SUPER_ADMIN]],
      [SystemRole.ADMIN, [ALL, ADMIN]],
      [SystemRole.VIEWER, [ALL]],
    ])(
      '%s → role filter from the ONE map, plus not-dismissed-by-me',
      (role, roles) => {
        const caller: NotificationCaller = { id: 'cme', role };
        expect(visibleTo(caller)).toEqual({
          targetRole: { in: roles },
          receipts: {
            none: { systemUserId: 'cme', dismissedAt: { not: null } },
          },
        });
      },
    );

    it('returns a COPY of the role list, so a caller cannot mutate the map', () => {
      const where = visibleTo({ id: 'cme', role: SystemRole.VIEWER });
      (where.targetRole as { in: AdminNotificationTargetRole[] }).in.push(
        SUPER_ADMIN,
      );
      expect(VISIBLE_TARGET_ROLES[SystemRole.VIEWER]).toEqual([ALL]);
    });
  });

  describe('unreadFor / readFor', () => {
    it('unread is NONE-with-readAt (so "no receipt row" counts as unread)', () => {
      expect(unreadFor('cme')).toEqual({
        receipts: { none: { systemUserId: 'cme', readAt: { not: null } } },
      });
    });

    it('read is SOME-with-readAt', () => {
      expect(readFor('cme')).toEqual({
        receipts: { some: { systemUserId: 'cme', readAt: { not: null } } },
      });
    });
  });

  describe('allOf — the only way to compose (design §6.1)', () => {
    const caller: NotificationCaller = { id: 'cme', role: SystemRole.ADMIN };

    it('keeps BOTH `none` clauses (dismissal and unread)', () => {
      const where = allOf(visibleTo(caller), unreadFor(caller.id));
      expect(where).toEqual({ AND: [visibleTo(caller), unreadFor(caller.id)] });
      const nones = (where.AND as Array<{ receipts?: { none?: unknown } }>)
        .map((c) => c.receipts?.none)
        .filter(Boolean);
      expect(nones).toEqual([
        { systemUserId: 'cme', dismissedAt: { not: null } },
        { systemUserId: 'cme', readAt: { not: null } },
      ]);
    });

    it('documents WHY: an object spread silently drops the dismissal filter', () => {
      const spread = { ...visibleTo(caller), ...unreadFor(caller.id) };
      expect(JSON.stringify(spread)).not.toContain('dismissedAt');
    });
  });
});
