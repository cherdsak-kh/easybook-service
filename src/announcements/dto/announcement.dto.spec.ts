import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { AnnouncementAudience, AnnouncementFormat } from '@prisma/client';
import { ListAnnouncementsQueryDto } from './announcement-query.dto';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './announcement-write.dto';

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

const create = (value: unknown) => run(CreateAnnouncementDto, 'body', value);
const update = (value: unknown) => run(UpdateAnnouncementDto, 'body', value);
const query = (value: Record<string, string>) =>
  run(ListAnnouncementsQueryDto, 'query', value);

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

describe('CreateAnnouncementDto (through the global ValidationPipe)', () => {
  it('accepts a title-only body and trims it (AC-2)', async () => {
    const dto = await create({ title: '  ปิดปรับปรุง  ' });
    expect(dto.title).toBe('ปิดปรับปรุง');
    expect(dto.body).toBeUndefined();
    expect(dto.departmentId).toBeUndefined();
  });

  it('accepts every optional field', async () => {
    await expect(
      create({
        title: 't',
        body: '  b  ',
        format: AnnouncementFormat.FLEX,
        audience: AnnouncementAudience.DEPARTMENT,
        departmentId: 3,
      }),
    ).resolves.toMatchObject({
      body: 'b',
      format: AnnouncementFormat.FLEX,
      audience: AnnouncementAudience.DEPARTMENT,
      departmentId: 3,
    });
  });

  it('accepts departmentId: null — it means "no department"', async () => {
    const dto = await create({ title: 't', departmentId: null });
    expect(dto.departmentId).toBeNull();
  });

  it('accepts the int4 maximum as a departmentId (the service decides whether it exists)', async () => {
    await expect(
      create({ title: 't', departmentId: 2_147_483_647 }),
    ).resolves.toMatchObject({ departmentId: 2_147_483_647 });
  });

  it.each([
    ['a missing title', {}],
    ['a whitespace-only title', { title: '   \n\t ' }],
    ['a null title', { title: null }],
    ['a non-string title', { title: 42 }],
  ])('refuses %s (AC-4, D-4)', async (_label, body) => {
    const messages = await refusal(create(body));
    expect(messages.join(' ')).toContain('title');
  });

  it('counts the title AFTER trimming: 100 ok, 101 refused (AC-4)', async () => {
    await expect(
      create({ title: `  ${'ก'.repeat(100)}  ` }),
    ).resolves.toMatchObject({ title: 'ก'.repeat(100) });
    await refusal(create({ title: 'ก'.repeat(101) }));
  });

  it('counts the body AFTER trimming: 1000 ok, 1001 refused (AC-4)', async () => {
    await expect(
      create({ title: 't', body: ` ${'ข'.repeat(1000)} ` }),
    ).resolves.toMatchObject({ body: 'ข'.repeat(1000) });
    const messages = await refusal(
      create({ title: 't', body: 'ข'.repeat(1001) }),
    );
    expect(messages.join(' ')).toContain('body');
  });

  it('refuses an explicit null for a non-nullable optional field', async () => {
    await refusal(create({ title: 't', body: null }));
    await refusal(create({ title: 't', format: null }));
    await refusal(create({ title: 't', audience: null }));
  });

  it.each([
    ['format', 'HTML'],
    ['format', 'text'],
    ['audience', 'STAFF'],
    ['audience', 'all'],
  ])('refuses a bad enum value %s=%s (AC-4)', async (key, value) => {
    const messages = await refusal(create({ title: 't', [key]: value }));
    expect(messages.join(' ')).toContain(key);
  });

  it.each([
    ['a numeric string', '3'],
    ['zero', 0],
    ['a negative id', -1],
    ['a fraction', 1.5],
    ['beyond int4 (would be a Prisma 500)', 2_147_483_648],
  ])('refuses departmentId as %s', async (_label, departmentId) => {
    const messages = await refusal(create({ title: 't', departmentId }));
    expect(messages.join(' ')).toContain('departmentId');
  });

  it.each([
    ['status', 'SENT'],
    ['sentAt', '2026-09-22T00:00:00.000Z'],
    ['sentCount', 5],
    ['createdById', 'clx_attacker'],
    ['id', 'clx_chosen'],
    ['createdAt', '2026-09-22T00:00:00.000Z'],
    ['somethingElse', 1],
  ])('refuses a body containing `%s` (AC-3, D-1)', async (key, value) => {
    const messages = await refusal(create({ title: 't', [key]: value }));
    expect(messages.join(' ')).toContain(`property ${key} should not exist`);
  });
});

describe('UpdateAnnouncementDto (through the global ValidationPipe)', () => {
  it('lets an empty body through the pipe — the SERVICE refuses it with one string (S-2)', async () => {
    const dto = await update({});
    expect(dto.title).toBeUndefined();
    expect(dto.body).toBeUndefined();
    expect(dto.format).toBeUndefined();
    expect(dto.audience).toBeUndefined();
    expect(dto.departmentId).toBeUndefined();
  });

  it('refuses title: null — not PartialType (S-1)', async () => {
    const messages = await refusal(update({ title: null }));
    expect(messages.join(' ')).toContain('title');
  });

  it('refuses a whitespace-only or 101-character title (AC-4)', async () => {
    await refusal(update({ title: '    ' }));
    await refusal(update({ title: 'x'.repeat(101) }));
  });

  it('allows body "" (clears it) but refuses body: null and a 1001-character body', async () => {
    await expect(update({ body: '   ' })).resolves.toMatchObject({
      body: '',
    });
    await refusal(update({ body: null }));
    await refusal(update({ body: 'x'.repeat(1001) }));
  });

  it('accepts departmentId: null (clear) and refuses "3"', async () => {
    await expect(update({ departmentId: null })).resolves.toMatchObject({
      departmentId: null,
    });
    await refusal(update({ departmentId: '3' }));
  });

  it('refuses bad enums and null enums (AC-4)', async () => {
    await refusal(update({ format: 'HTML' }));
    await refusal(update({ audience: 'STAFF' }));
    await refusal(update({ format: null }));
    await refusal(update({ audience: null }));
  });

  it.each(['status', 'sentAt', 'sentCount', 'createdById'])(
    'refuses a body containing `%s`',
    async (key) => {
      const messages = await refusal(update({ title: 't', [key]: 'x' }));
      expect(messages.join(' ')).toContain(`property ${key} should not exist`);
    },
  );
});

describe('ListAnnouncementsQueryDto (through the global ValidationPipe)', () => {
  it('defaults page=1, limit=10, status=all', async () => {
    await expect(query({})).resolves.toMatchObject({
      page: 1,
      limit: 10,
      status: 'all',
    });
  });

  it.each(['10', '20', '50'])('accepts limit=%s', async (limit) => {
    await expect(query({ limit })).resolves.toMatchObject({
      limit: Number(limit),
    });
  });

  it.each(['25', '0', '100', 'abc'])(
    'refuses limit=%s — never clamped',
    async (limit) => {
      await refusal(query({ limit }));
    },
  );

  it('refuses page=0 and an unknown key', async () => {
    await refusal(query({ page: '0' }));
    const messages = await refusal(query({ foo: '1' }));
    expect(messages.join(' ')).toContain('property foo should not exist');
  });

  it.each(['all', 'sent', 'draft'])('accepts status=%s', async (status) => {
    await expect(query({ status })).resolves.toMatchObject({ status });
  });

  it.each(['DRAFT', 'SENT', 'nope', ''])(
    'refuses status=%j — the filter is lowercase (S-3)',
    async (status) => {
      await refusal(query({ status }));
    },
  );

  it('trims q and refuses q over 100 characters', async () => {
    await expect(query({ q: '  ประกาศ  ' })).resolves.toMatchObject({
      q: 'ประกาศ',
    });
    await refusal(query({ q: 'x'.repeat(101) }));
  });
});
