import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SystemRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { NotificationsController } from './notifications.controller';

/**
 * Route METADATA, read without HTTP: the two structural rules the controller's doc comment states.
 */
const proto = NotificationsController.prototype as unknown as Record<
  string,
  object
>;
const handlers = Object.getOwnPropertyNames(proto).filter(
  (name) => name !== 'constructor',
);
const meta = (name: string) => ({
  name,
  method: Reflect.getMetadata(METHOD_METADATA, proto[name]) as RequestMethod,
  path: Reflect.getMetadata(PATH_METADATA, proto[name]) as string,
  roles: Reflect.getMetadata(ROLES_KEY, proto[name]) as
    SystemRole[] | undefined,
});

describe('NotificationsController (route metadata)', () => {
  it('declares the six handlers in the design’s order (§3)', () => {
    expect(handlers).toEqual([
      'list',
      'unreadCount',
      'markManyRead',
      'dismiss',
      'markRead',
      'markUnread',
    ]);
  });

  it('AC-18 / R-3 — every literal path is declared above every :id path', () => {
    const paths = handlers.map((h) => meta(h).path);
    const firstParam = paths.findIndex((p) => p.includes(':'));
    const lastLiteral = paths.reduce(
      (last, p, i) => (p.includes(':') ? last : i),
      -1,
    );
    expect(firstParam).toBeGreaterThan(lastLiteral);
  });

  it('every route lists all three roles', () => {
    for (const h of handlers) {
      expect([...(meta(h).roles ?? [])].sort()).toEqual(
        [SystemRole.ADMIN, SystemRole.SUPER_ADMIN, SystemRole.VIEWER].sort(),
      );
    }
  });

  it('R-9 — the VIEWER non-GET allowlist is EXACTLY the four own-state writes (D-3)', () => {
    const viewerWrites = handlers
      .map(meta)
      .filter(
        (m) =>
          m.method !== RequestMethod.GET &&
          (m.roles ?? []).includes(SystemRole.VIEWER),
      )
      .map((m) => `${RequestMethod[m.method]} ${m.path}`)
      .sort();
    expect(viewerWrites).toEqual(
      [
        'POST read-all',
        'DELETE bulk',
        'PATCH :id/read',
        'PATCH :id/unread',
      ].sort(),
    );
  });

  it('D-4 — there is no creation route', () => {
    const posts = handlers
      .map(meta)
      .filter((m) => m.method === RequestMethod.POST)
      .map((m) => m.path);
    expect(posts).toEqual(['read-all']);
  });
});
