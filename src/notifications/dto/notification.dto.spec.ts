import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { AdminNotificationCategory } from '@prisma/client';
import { ListAdminNotificationsQueryDto } from './notification-query.dto';
import {
  DismissAdminNotificationsDto,
  MarkAdminNotificationsReadDto,
} from './notification-write.dto';

/** The exact global pipe from `app.setup.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const run = <T>(
  metatype: new () => T,
  type: ArgumentMetadata['type'],
  value: unknown,
): Promise<T> => pipe.transform(value, { type, metatype }) as Promise<T>;

const query = (value: Record<string, unknown>) =>
  run(ListAdminNotificationsQueryDto, 'query', value);
const markBody = (value: unknown) =>
  run(MarkAdminNotificationsReadDto, 'body', value);
const dismissBody = (value: unknown) =>
  run(DismissAdminNotificationsDto, 'body', value);

/** Resolves to the pipe's `message[]` on a refusal, or throws if it accepted. */
const refusal = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (e) {
    const response = (e as { response?: { message?: string[] } }).response;
    if (!response?.message) throw e;
    return response.message;
  }
  throw new Error('expected a ValidationPipe rejection');
};

const cuid = (n: number) => `c${String(n).padStart(24, '0')}`;
const ID_A = 'clx0v3n0e0000abcd1234efgh';

describe('ListAdminNotificationsQueryDto (through the global ValidationPipe)', () => {
  describe('isRead — the string → boolean transform (plan R-8, AC-7)', () => {
    it('"true" → true', async () => {
      const dto = await query({ isRead: 'true' });
      expect(dto.isRead).toBe(true);
    });

    it('🔴 "false" → false (NOT true, which @Type(() => Boolean) would produce)', async () => {
      const dto = await query({ isRead: 'false' });
      expect(dto.isRead).toBe(false);
      expect(dto.isRead).not.toBe(true);
    });

    it('absent → undefined (both read states)', async () => {
      const dto = await query({});
      expect(dto.isRead).toBeUndefined();
    });

    it.each([['1'], ['0'], ['yes'], [''], ['TRUE'], [['true', 'false']]])(
      'refuses %j',
      async (value) => {
        const messages = await refusal(query({ isRead: value }));
        expect(messages.join(' ')).toContain('isRead');
      },
    );
  });

  describe('page / limit (AC-10)', () => {
    it('defaults page=1, limit=10', async () => {
      const dto = await query({});
      expect(dto.page).toBe(1);
      expect(dto.limit).toBe(10);
    });

    it.each([['1'], ['5'], ['10'], ['20'], ['50']])(
      'accepts limit=%s (a range, not the house 10/20/50 set — the bell asks for 5)',
      async (limit) => {
        const dto = await query({ limit });
        expect(dto.limit).toBe(Number(limit));
      },
    );

    it.each([['0'], ['51'], ['-1'], ['1.5'], ['abc']])(
      'refuses limit=%s',
      async (limit) => {
        const messages = await refusal(query({ limit }));
        expect(messages.join(' ')).toContain('limit');
      },
    );

    it.each([['0'], ['-1'], ['x']])('refuses page=%s', async (page) => {
      const messages = await refusal(query({ page }));
      expect(messages.join(' ')).toContain('page');
    });
  });

  describe('category / period', () => {
    it.each(Object.values(AdminNotificationCategory))(
      'accepts category=%s',
      async (category) => {
        const dto = await query({ category });
        expect(dto.category).toBe(category);
      },
    );

    it.each([['bookings'], ['booking'], ['users']])(
      'refuses the prototype key / lower case %s',
      async (category) => {
        await refusal(query({ category }));
      },
    );

    it.each([['today'], ['7d'], ['30d']])(
      'accepts period=%s',
      async (period) => {
        const dto = await query({ period });
        expect(dto.period).toBe(period);
      },
    );

    it.each([['week'], ['1d'], ['TODAY']])(
      'refuses period=%s',
      async (period) => {
        await refusal(query({ period }));
      },
    );
  });

  describe('search (AC-9)', () => {
    it('trims, and counts AFTER trimming: 100 ok, 101 refused', async () => {
      const ok = await query({ search: `  ${'ก'.repeat(100)}  ` });
      expect(ok.search).toBe('ก'.repeat(100));
      const messages = await refusal(query({ search: 'a'.repeat(101) }));
      expect(messages.join(' ')).toContain('search');
    });

    it('whitespace-only becomes "" (the service then applies no filter)', async () => {
      const dto = await query({ search: '   ' });
      expect(dto.search).toBe('');
    });

    it('is Thai-normalised the same way create() stores title/body', async () => {
      const dto = await query({ search: 'เเก้ว' }); // SARA E twice
      expect(dto.search).toBe('แก้ว');
    });
  });

  it.each([['systemUserId'], ['targetRole'], ['q'], ['readAt']])(
    'refuses the unknown key %s (forbidNonWhitelisted)',
    async (key) => {
      await refusal(query({ [key]: 'x' }));
    },
  );
});

describe('MarkAdminNotificationsReadDto (E-5 body)', () => {
  it('no body → ids undefined ("mark all")', async () => {
    const dto = await markBody(undefined);
    expect(dto.ids).toBeUndefined();
  });

  it('{} → ids undefined ("mark all")', async () => {
    const dto = await markBody({});
    expect(dto.ids).toBeUndefined();
  });

  it('accepts 1 and 50 unique cuids', async () => {
    expect((await markBody({ ids: [ID_A] })).ids).toEqual([ID_A]);
    const fifty = Array.from({ length: 50 }, (_, i) => cuid(i));
    expect((await markBody({ ids: fifty })).ids).toHaveLength(50);
  });

  it.each([
    ['ids: null (never read as "all")', { ids: null }],
    ['ids: []', { ids: [] }],
    ['51 ids', { ids: Array.from({ length: 51 }, (_, i) => cuid(i)) }],
    ['a duplicate', { ids: [ID_A, ID_A] }],
    ['a non-cuid', { ids: ['seed_notif_01'] }],
    ['an upper-case cuid', { ids: [ID_A.toUpperCase()] }],
    ['a non-string', { ids: [42] }],
    ['a string instead of an array', { ids: ID_A }],
    ['systemUserId', { systemUserId: ID_A }],
  ])('refuses %s', async (_label, value) => {
    await refusal(markBody(value));
  });
});

describe('DismissAdminNotificationsDto (E-6 body, AC-14)', () => {
  it('accepts { ids }', async () => {
    const dto = await dismissBody({ ids: [ID_A] });
    expect(dto.ids).toEqual([ID_A]);
    expect(dto.allRead).toBeUndefined();
  });

  it('accepts { allRead: true }', async () => {
    const dto = await dismissBody({ allRead: true });
    expect(dto.allRead).toBe(true);
    expect(dto.ids).toBeUndefined();
  });

  it('lets both keys, {} and no body THROUGH the pipe — the SERVICE refuses them with one string (S-9)', async () => {
    const both = await dismissBody({ ids: [ID_A], allRead: true });
    expect(both.ids).toEqual([ID_A]);
    expect(both.allRead).toBe(true);
    const empty = await dismissBody({});
    expect(empty.ids).toBeUndefined();
    expect(empty.allRead).toBeUndefined();
    const none = await dismissBody(undefined);
    expect(none.ids).toBeUndefined();
    expect(none.allRead).toBeUndefined();
  });

  it.each([
    ['allRead: false', { allRead: false }],
    ['allRead: "true"', { allRead: 'true' }],
    ['allRead: null', { allRead: null }],
    ['ids: null', { ids: null }],
    ['ids: []', { ids: [] }],
    ['51 ids', { ids: Array.from({ length: 51 }, (_, i) => cuid(i)) }],
    ['a duplicate', { ids: [ID_A, ID_A] }],
    ['a non-cuid', { ids: ['not-a-cuid'] }],
    ['systemUserId', { ids: [ID_A], systemUserId: ID_A }],
    ['dismissedAt', { ids: [ID_A], dismissedAt: '2026-01-01' }],
  ])('refuses %s', async (_label, value) => {
    await refusal(dismissBody(value));
  });
});
