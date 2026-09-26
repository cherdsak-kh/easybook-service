import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AdminNotificationCategory,
  AdminNotificationTargetRole,
  AdminNotificationTone,
  Prisma,
  SystemRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ListAdminNotificationsQueryDto } from './dto/notification-query.dto';
import {
  NOTIFICATION_DISMISS_TARGET,
  NOTIFICATION_NOT_FOUND,
} from './notifications.constants';
import { periodFloor } from './notifications.period';
import {
  unreadFor,
  visibleTo,
  type NotificationCaller,
} from './notifications.policy';
import {
  NotificationsService,
  escapeLike,
  normaliseCreateInput,
  notificationListWhere,
  notificationSearchTerm,
  toAdminNotificationDto,
  toUnreadCount,
  type CreateAdminNotificationInput,
} from './notifications.service';

const ID = 'clx0v3n0e0000abcd1234efgh';
const SUPER: NotificationCaller = {
  id: 'csuper00000000000000000000',
  role: SystemRole.SUPER_ADMIN,
};
const ADMIN: NotificationCaller = {
  id: 'cadmin00000000000000000000',
  role: SystemRole.ADMIN,
};
const VIEWER: NotificationCaller = {
  id: 'cviewer0000000000000000000',
  role: SystemRole.VIEWER,
};

/** PII that must never reach a log line (plan §5). */
const TITLE = 'ผู้ใช้ลงทะเบียนใหม่ สมชาย ใจดี';
const BODY = 'สมชาย ใจดี · ครู · ฝ่ายวิชาการ · 081-234-5678';

/** The first argument of a mock's Nth call, typed — keeps the casts in ONE place (lint-safe). */
const callArg = <T>(fn: jest.Mock, call = 0): T =>
  (fn.mock.calls as unknown as unknown[][])[call][0] as T;

const input = (
  over: Partial<CreateAdminNotificationInput> = {},
): CreateAdminNotificationInput => ({
  category: AdminNotificationCategory.REGISTRATION,
  tone: AdminNotificationTone.AMBER,
  icon: 'user-plus',
  title: TITLE,
  body: BODY,
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  category: AdminNotificationCategory.BOOKING,
  code: 'BR-25690903-001',
  title: TITLE,
  body: BODY,
  tone: AdminNotificationTone.SKY,
  icon: 'calendar',
  actionUrl: '/backend/bookings/requests',
  actionLabel: 'ดูคำขอจอง',
  targetRole: AdminNotificationTargetRole.ADMIN,
  createdAt: new Date('2026-09-26T02:00:00.000Z'),
  updatedAt: new Date('2026-09-26T02:00:00.000Z'),
  receipts: [] as { readAt: Date | null }[],
  ...over,
});

const listQuery = (
  over: Partial<ListAdminNotificationsQueryDto> = {},
): ListAdminNotificationsQueryDto => ({ page: 1, limit: 10, ...over });

describe('normaliseCreateInput (create() validation, AC-17)', () => {
  it('defaults targetRole to ALL and nulls every optional field', () => {
    const data = normaliseCreateInput(input());
    expect(data).toEqual({
      category: AdminNotificationCategory.REGISTRATION,
      tone: AdminNotificationTone.AMBER,
      icon: 'user-plus',
      title: TITLE,
      body: BODY,
      code: null,
      actionUrl: null,
      actionLabel: null,
      targetRole: AdminNotificationTargetRole.ALL,
    });
  });

  it('keeps an explicit targetRole', () => {
    expect(
      normaliseCreateInput(
        input({ targetRole: AdminNotificationTargetRole.SUPER_ADMIN }),
      ).targetRole,
    ).toBe(AdminNotificationTargetRole.SUPER_ADMIN);
  });

  it('sanitises (and so trims) title, body and label — search and store agree', () => {
    const data = normaliseCreateInput(
      input({
        title: '  เเก้ว  ',
        body: ' ข้อความ\u200B ',
        actionUrl: '/backend/line-users',
        actionLabel: '  ตรวจสอบข้อมูล ',
      }),
    );
    expect(data.title).toBe('แก้ว');
    expect(data.body).toBe('ข้อความ');
    expect(data.actionLabel).toBe('ตรวจสอบข้อมูล');
  });

  it("trims code, and '' → null", () => {
    expect(normaliseCreateInput(input({ code: '  BR-1  ' })).code).toBe('BR-1');
    expect(normaliseCreateInput(input({ code: '   ' })).code).toBeNull();
    expect(normaliseCreateInput(input({ code: null })).code).toBeNull();
  });

  it('accepts a /backend/ deep link paired with a label', () => {
    const data = normaliseCreateInput(
      input({
        actionUrl: '/backend/bookings/requests?status=PENDING',
        actionLabel: 'ดูคำขอจอง',
      }),
    );
    expect(data.actionUrl).toBe('/backend/bookings/requests?status=PENDING');
  });

  it.each([
    ['https://evil.example/backend/'],
    ['//evil.example'],
    ['/backend//evil.example'],
    ['/backend\\evil'],
    ['javascript:alert(1)'],
    ['/backendx/foo'],
    ['/admin/foo'],
    ['backend/foo'],
    ['/backend/a b'],
    ['/backend/a\tb'],
    ['/backend/a\nb'],
    ['/backend/a\u0000b'],
    [`/backend/${'a'.repeat(512)}`],
  ])('rejects actionUrl %j (open-redirect guard, D-7)', (actionUrl) => {
    expect(() =>
      normaliseCreateInput(input({ actionUrl, actionLabel: 'ดู' })),
    ).toThrow(/actionUrl/);
  });

  it.each([
    ['url without label', { actionUrl: '/backend/feedback' }],
    ['label without url', { actionLabel: 'ดู' }],
    [
      'url with null label',
      { actionUrl: '/backend/feedback', actionLabel: null },
    ],
  ])('rejects a CTA half: %s (S-8 both-or-neither)', (_l, over) => {
    expect(() => normaliseCreateInput(input(over))).toThrow(/both/);
  });

  it.each([
    ['category', { category: 'bookings' }],
    ['tone', { tone: 'sky' }],
    ['icon', { icon: 'warn' }],
    ['icon', { icon: 'bug' }],
    ['targetRole', { targetRole: 'VIEWER' }],
  ])('rejects an unknown %s', (field, over) => {
    expect(() =>
      normaliseCreateInput(
        input(over as unknown as Partial<CreateAdminNotificationInput>),
      ),
    ).toThrow(new RegExp(field));
  });

  it.each([
    ['title', { title: '   ' }],
    ['title', { title: 'ก'.repeat(201) }],
    ['body', { body: '' }],
    ['body', { body: 'ก'.repeat(1001) }],
    ['code', { code: 'x'.repeat(65) }],
    [
      'actionLabel',
      { actionUrl: '/backend/feedback', actionLabel: 'ก'.repeat(61) },
    ],
    ['actionLabel', { actionUrl: '/backend/feedback', actionLabel: '   ' }],
  ])('rejects an out-of-range %s', (field, over) => {
    expect(() => normaliseCreateInput(input(over))).toThrow(new RegExp(field));
  });

  it('accepts the exact caps (200 / 1000 / 64 / 60)', () => {
    expect(() =>
      normaliseCreateInput(
        input({
          title: 'ก'.repeat(200),
          body: 'ก'.repeat(1000),
          code: 'x'.repeat(64),
          actionUrl: '/backend/feedback',
          actionLabel: 'ก'.repeat(60),
        }),
      ),
    ).not.toThrow();
  });

  it('never puts the title or body in an error message (PDPA)', () => {
    try {
      normaliseCreateInput(input({ icon: 'nope' as never }));
    } catch (e) {
      expect((e as Error).message).not.toContain('สมชาย');
    }
  });
});

describe('notificationSearchTerm', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['#', null],
    ['  #  ', null],
    ['#BR-1', 'BR-1'],
    ['# BR-1', 'BR-1'],
    ['##x', '#x'],
    ['50%_off', '50%_off'],
  ])('%j → %j', (search, expected) => {
    expect(notificationSearchTerm(search)).toBe(expected);
  });
});

describe('escapeLike', () => {
  it.each([
    ['plain', 'plain'],
    ['50%', '50\\%'],
    ['a_b', 'a\\_b'],
    ['back\\slash', 'back\\\\slash'],
    ['ห้อง_1%', 'ห้อง\\_1\\%'],
  ])('%j → %j', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });
});

describe('notificationListWhere (design §6.1–§6.2)', () => {
  const clauses = (w: Prisma.AdminNotificationWhereInput) =>
    w.AND as Prisma.AdminNotificationWhereInput[];

  it('no filters → exactly the visibility clause, inside AND', () => {
    expect(notificationListWhere(ADMIN, listQuery(), null)).toEqual({
      AND: [visibleTo(ADMIN)],
    });
  });

  it('🔴 isRead=false keeps BOTH `none` clauses (dismissal AND unread)', () => {
    const where = notificationListWhere(
      ADMIN,
      listQuery({ isRead: false }),
      null,
    );
    expect(clauses(where)).toEqual([visibleTo(ADMIN), unreadFor(ADMIN.id)]);
    const json = JSON.stringify(where);
    expect(json).toContain('"dismissedAt":{"not":null}');
    expect(json).toContain('"readAt":{"not":null}');
  });

  it('isRead=true → the SOME-with-readAt clause; isRead=false never looks like true', () => {
    const read = notificationListWhere(
      ADMIN,
      listQuery({ isRead: true }),
      null,
    );
    const unread = notificationListWhere(
      ADMIN,
      listQuery({ isRead: false }),
      null,
    );
    expect(JSON.stringify(read)).toContain('"some"');
    expect(JSON.stringify(unread)).not.toContain('"some"');
    expect(read).not.toEqual(unread);
  });

  it('combines category, period floor and search with AND', () => {
    const floor = new Date('2026-09-25T17:00:00.000Z');
    const where = notificationListWhere(
      VIEWER,
      listQuery({
        category: AdminNotificationCategory.FEEDBACK,
        search: '#iss-1',
      }),
      floor,
    );
    const like = { contains: 'iss-1', mode: 'insensitive' };
    expect(clauses(where)).toEqual([
      visibleTo(VIEWER),
      { category: AdminNotificationCategory.FEEDBACK },
      { createdAt: { gte: floor } },
      { OR: [{ title: like }, { body: like }, { code: like }] },
    ]);
  });

  it('% _ and \\ are escaped so they match literally (Prisma 7 does not escape `contains`)', () => {
    const where = notificationListWhere(
      ADMIN,
      listQuery({ search: '50%_off\\' }),
      null,
    );
    const like = { contains: '50\\%\\_off\\\\', mode: 'insensitive' };
    expect(clauses(where)[1]).toEqual({
      OR: [{ title: like }, { body: like }, { code: like }],
    });
  });

  it('an empty search adds no clause (never contains: "")', () => {
    expect(
      clauses(notificationListWhere(ADMIN, listQuery({ search: '' }), null)),
    ).toHaveLength(1);
  });
});

describe('toAdminNotificationDto / toUnreadCount', () => {
  it('no receipt → isRead false, readAt null; never leaks receipts', () => {
    const dto = toAdminNotificationDto(row());
    expect(dto.isRead).toBe(false);
    expect(dto.readAt).toBeNull();
    expect(dto).not.toHaveProperty('receipts');
    expect(dto).not.toHaveProperty('dismissedAt');
    expect(dto.createdAt).toBe('2026-09-26T02:00:00.000Z');
  });

  it('receipt with readAt → isRead true and the ISO readAt', () => {
    const readAt = new Date('2026-09-26T03:00:00.000Z');
    const dto = toAdminNotificationDto(row({ receipts: [{ readAt }] }));
    expect(dto.isRead).toBe(true);
    expect(dto.readAt).toBe(readAt.toISOString());
  });

  it('receipt with readAt null (read, then unread) → unread', () => {
    expect(
      toAdminNotificationDto(row({ receipts: [{ readAt: null }] })).isRead,
    ).toBe(false);
  });

  it('fills all four categories and sums them', () => {
    expect(
      toUnreadCount([
        { category: AdminNotificationCategory.BOOKING, _count: { _all: 2 } },
        { category: AdminNotificationCategory.SYSTEM, _count: { _all: 1 } },
      ]),
    ).toEqual({
      total: 3,
      byCategory: { BOOKING: 2, REGISTRATION: 0, FEEDBACK: 0, SYSTEM: 1 },
    });
    expect(toUnreadCount([]).total).toBe(0);
  });
});

describe('NotificationsService', () => {
  let service: NotificationsService;

  const adminNotification = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    create: jest.fn(),
  };
  const adminNotificationReceipt = {
    updateMany: jest.fn(),
    createMany: jest.fn(),
  };
  const tx = {
    adminNotification: { findMany: jest.fn() },
    adminNotificationReceipt: { createMany: jest.fn(), updateMany: jest.fn() },
  };
  const $transaction = jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
    fn(tx),
  );
  const $executeRaw = jest.fn();

  let logSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: PrismaService,
          useValue: {
            adminNotification,
            adminNotificationReceipt,
            $transaction,
            $executeRaw,
          },
        },
      ],
    }).compile();
    service = module.get(NotificationsService);
  });

  afterEach(() => {
    logSpy.mockRestore();
    debugSpy.mockRestore();
  });

  /**
   * A nested `Prisma.sql` fragment. Duck-typed: `Prisma.Sql` is a type only in Prisma 7 — there is no
   * runtime class to `instanceof` against.
   */
  const isSqlFragment = (v: unknown): v is Prisma.Sql =>
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as Prisma.Sql).strings) &&
    Array.isArray((v as Prisma.Sql).values);

  /** Every value bound into the tagged template, flattened through nested `Prisma.sql` fragments. */
  const boundValues = (): unknown[] => {
    const args = $executeRaw.mock.calls[0] as unknown[];
    const values: unknown[] = [];
    for (const v of args.slice(1)) {
      if (isSqlFragment(v)) values.push(...v.values);
      else values.push(v);
    }
    return values;
  };

  describe('list', () => {
    it('pages, orders totally, selects ONLY the caller receipt, and computes meta', async () => {
      adminNotification.findMany.mockResolvedValue([row()]);
      adminNotification.count.mockResolvedValue(21);
      const now = new Date('2026-09-26T03:00:00.000Z');

      const res = await service.list(
        ADMIN,
        listQuery({ page: 3, limit: 10, period: 'today' }),
        now,
      );

      const args = callArg<{
        where: Prisma.AdminNotificationWhereInput;
        orderBy: unknown;
        skip: number;
        take: number;
        select: { receipts: { where: unknown } };
      }>(adminNotification.findMany);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
      expect(args.select.receipts.where).toEqual({ systemUserId: ADMIN.id });
      expect(args.where).toEqual(
        notificationListWhere(
          ADMIN,
          listQuery({ period: 'today' }),
          periodFloor('today', now),
        ),
      );
      // The SAME where for the page and its total.
      expect(callArg(adminNotification.count)).toEqual({ where: args.where });
      expect(res.meta).toEqual({
        page: 3,
        limit: 10,
        total: 21,
        totalPages: 3,
      });
      expect(res.data).toHaveLength(1);
    });

    it('total 0 → totalPages 0', async () => {
      adminNotification.findMany.mockResolvedValue([]);
      adminNotification.count.mockResolvedValue(0);
      const res = await service.list(ADMIN, listQuery());
      expect(res.meta.totalPages).toBe(0);
      expect(res.data).toEqual([]);
    });
  });

  describe('unreadCount', () => {
    it('groupBy category over EXACTLY visibleTo AND unreadFor', async () => {
      adminNotification.groupBy.mockResolvedValue([
        { category: AdminNotificationCategory.FEEDBACK, _count: { _all: 4 } },
      ]);
      const res = await service.unreadCount(VIEWER);
      expect(callArg(adminNotification.groupBy)).toEqual({
        by: ['category'],
        where: { AND: [visibleTo(VIEWER), unreadFor(VIEWER.id)] },
        _count: { _all: true },
      });
      expect(res).toEqual({
        total: 4,
        byCategory: { BOOKING: 0, REGISTRATION: 0, FEEDBACK: 4, SYSTEM: 0 },
      });
    });
  });

  describe('markRead / markUnread — the single-id 404 gate', () => {
    it.each([['not-a-cuid'], ['seed_notif_01'], [''], [ID.toUpperCase()]])(
      'a malformed id %j is the 404 WITHOUT a query (never a 400)',
      async (id) => {
        await expect(service.markRead(ADMIN, id)).rejects.toThrow(
          new NotFoundException(NOTIFICATION_NOT_FOUND),
        );
        await expect(service.markUnread(ADMIN, id)).rejects.toThrow(
          NotFoundException,
        );
        expect(adminNotification.findFirst).not.toHaveBeenCalled();
        expect($executeRaw).not.toHaveBeenCalled();
      },
    );

    it('an invisible / unknown / dismissed id is the same 404, and nothing is written', async () => {
      adminNotification.findFirst.mockResolvedValue(null);
      await expect(service.markRead(ADMIN, ID)).rejects.toThrow(
        new NotFoundException(NOTIFICATION_NOT_FOUND),
      );
      expect(callArg(adminNotification.findFirst)).toEqual({
        where: { AND: [visibleTo(ADMIN), { id: ID }] },
        select: { id: true },
      });
      expect($executeRaw).not.toHaveBeenCalled();

      await expect(service.markUnread(ADMIN, ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(adminNotificationReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('markRead writes through the one read statement scoped to [id], then returns the item as the caller sees it', async () => {
      const readAt = new Date('2026-09-26T04:00:00.000Z');
      adminNotification.findFirst
        .mockResolvedValueOnce({ id: ID })
        .mockResolvedValueOnce(row({ receipts: [{ readAt }] }));
      $executeRaw.mockResolvedValue(1);

      const dto = await service.markRead(ADMIN, ID);

      expect($executeRaw).toHaveBeenCalledTimes(1);
      const values = boundValues();
      expect(values).toContainEqual([ID]);
      expect(values).toContain(ADMIN.id);
      expect(dto).toMatchObject({ id: ID, isRead: true });
      expect(dto.readAt).toBe(readAt.toISOString());
    });

    it('markUnread clears only the CALLER readAt and never creates a row', async () => {
      adminNotification.findFirst
        .mockResolvedValueOnce({ id: ID })
        .mockResolvedValueOnce(row());
      adminNotificationReceipt.updateMany.mockResolvedValue({ count: 0 });

      const dto = await service.markUnread(VIEWER, ID);

      expect(callArg(adminNotificationReceipt.updateMany)).toEqual({
        where: {
          systemUserId: VIEWER.id,
          notificationId: ID,
          readAt: { not: null },
        },
        data: { readAt: null },
      });
      expect(adminNotificationReceipt.createMany).not.toHaveBeenCalled();
      expect(dto.isRead).toBe(false);
    });
  });

  describe('markManyRead — the raw read-all statement', () => {
    it.each([
      [SUPER, ['ALL', 'ADMIN', 'SUPER_ADMIN']],
      [ADMIN, ['ALL', 'ADMIN']],
      [VIEWER, ['ALL']],
    ])(
      'binds the role list from VISIBLE_TARGET_ROLES (%#)',
      async (caller, roles) => {
        $executeRaw.mockResolvedValue(7);
        const res = await service.markManyRead(caller);
        expect(res).toEqual({ updated: 7 });
        expect(boundValues()).toContainEqual(roles);
      },
    );

    it('without ids the id fragment is EMPTY; with ids it is `n.id = ANY(…)` bound as one array parameter', async () => {
      /** The nested `Prisma.sql` fragment passed into the outer template. */
      const idFragment = (): Prisma.Sql =>
        ($executeRaw.mock.calls[0] as unknown[]).slice(1).find(isSqlFragment)!;

      $executeRaw.mockResolvedValue(0);
      await service.markManyRead(ADMIN);
      expect(idFragment().strings.join('')).toBe('');
      expect(idFragment().values).toEqual([]);

      $executeRaw.mockClear();
      await service.markManyRead(ADMIN, [ID]);
      expect(idFragment().strings.join('?')).toContain('n.id = ANY(');
      expect(idFragment().values).toEqual([[ID]]);
    });

    it('is a tagged template (bind parameters), never string-built SQL', async () => {
      $executeRaw.mockResolvedValue(0);
      await service.markManyRead(ADMIN, [ID]);
      const strings = ($executeRaw.mock.calls[0] as unknown[])[0] as string[];
      expect(strings.join('')).not.toContain(ADMIN.id);
      expect(strings.join('')).not.toContain(ID);
    });
  });

  describe('dismiss (E-6)', () => {
    it.each([
      ['both keys', { ids: [ID], allRead: true as const }],
      ['neither key', {}],
      ['no body', undefined],
    ])('%s → one-string 400 before ANY query (S-9)', async (_label, dto) => {
      await expect(service.dismiss(ADMIN, dto)).rejects.toThrow(
        new BadRequestException(NOTIFICATION_DISMISS_TARGET),
      );
      expect($transaction).not.toHaveBeenCalled();
      expect(adminNotificationReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('allRead → one updateMany over the caller’s READ, undismissed, role-visible receipts', async () => {
      adminNotificationReceipt.updateMany.mockResolvedValue({ count: 5 });
      const now = new Date('2026-09-26T05:00:00.000Z');

      const res = await service.dismiss(ADMIN, { allRead: true }, now);

      expect(res).toEqual({ deleted: 5 });
      expect(callArg(adminNotificationReceipt.updateMany)).toEqual({
        where: {
          systemUserId: ADMIN.id,
          readAt: { not: null },
          dismissedAt: null,
          notification: { targetRole: { in: ['ALL', 'ADMIN'] } },
        },
        data: { dismissedAt: now },
      });
    });

    it('ids → resolves the VISIBLE ones, inserts missing receipts dismissed, stamps the rest, in one transaction', async () => {
      const other = 'cother'.padEnd(25, '0');
      tx.adminNotification.findMany.mockResolvedValue([{ id: ID }]);
      tx.adminNotificationReceipt.createMany.mockResolvedValue({ count: 0 });
      tx.adminNotificationReceipt.updateMany.mockResolvedValue({ count: 1 });
      const now = new Date('2026-09-26T05:00:00.000Z');

      const res = await service.dismiss(VIEWER, { ids: [ID, other] }, now);

      expect(res).toEqual({ deleted: 1 });
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(callArg(tx.adminNotification.findMany)).toEqual({
        where: { AND: [visibleTo(VIEWER), { id: { in: [ID, other] } }] },
        select: { id: true },
      });
      expect(callArg(tx.adminNotificationReceipt.createMany)).toEqual({
        data: [
          { systemUserId: VIEWER.id, notificationId: ID, dismissedAt: now },
        ],
        skipDuplicates: true,
      });
      expect(callArg(tx.adminNotificationReceipt.updateMany)).toEqual({
        where: {
          systemUserId: VIEWER.id,
          notificationId: { in: [ID] },
          dismissedAt: null,
        },
        data: { dismissedAt: now },
      });
    });

    it('ids that are all invisible → 0, and nothing is written', async () => {
      tx.adminNotification.findMany.mockResolvedValue([]);
      const res = await service.dismiss(ADMIN, { ids: [ID] });
      expect(res).toEqual({ deleted: 0 });
      expect(tx.adminNotificationReceipt.createMany).not.toHaveBeenCalled();
      expect(tx.adminNotificationReceipt.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('create (D-4, AC-17)', () => {
    it('persists the normalised row and returns it; logs ids only (PDPA)', async () => {
      const created = { ...row(), receipts: undefined };
      adminNotification.create.mockResolvedValue(created);

      const res = await service.create(
        input({
          actionUrl: '/backend/line-users',
          actionLabel: 'ตรวจสอบข้อมูล',
        }),
      );

      expect(res).toBe(created);
      expect(callArg(adminNotification.create)).toEqual({
        data: normaliseCreateInput(
          input({
            actionUrl: '/backend/line-users',
            actionLabel: 'ตรวจสอบข้อมูล',
          }),
        ),
      });
      const logged = (logSpy.mock.calls as unknown[][])
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toContain(`id=${ID}`);
      expect(logged).not.toContain('สมชาย');
      expect(logged).not.toContain('081-234-5678');
    });

    it('rejects an invalid input BEFORE touching the database', async () => {
      await expect(
        service.create(input({ actionUrl: '//evil', actionLabel: 'x' })),
      ).rejects.toThrow(/actionUrl/);
      expect(adminNotification.create).not.toHaveBeenCalled();
    });
  });
});
