import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import {
  CreateCannedReplyDto,
  UpdateCannedReplyDto,
} from './canned-reply-write.dto';

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

const create = (value: unknown) => run(CreateCannedReplyDto, 'body', value);
const update = (value: unknown) => run(UpdateCannedReplyDto, 'body', value);

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

const VALID = { title: 'หัวข้อ', text: 'ข้อความ' };

describe('CreateCannedReplyDto (through the global ValidationPipe)', () => {
  it('accepts title + text, trims both, and leaves sortOrder absent', async () => {
    const dto = await create({ title: '  หัวข้อ  ', text: '\n ข้อความ \t' });
    expect(dto.title).toBe('หัวข้อ');
    expect(dto.text).toBe('ข้อความ');
    expect(dto.sortOrder).toBeUndefined();
  });

  it.each([
    ['a missing title', { text: 'x' }],
    ['an empty title', { ...VALID, title: '' }],
    ['a whitespace-only title', { ...VALID, title: '   ' }],
    ['a null title', { ...VALID, title: null }],
    ['a non-string title', { ...VALID, title: 42 }],
    ['a 101-character title', { ...VALID, title: 'ก'.repeat(101) }],
  ])('refuses %s', async (_label, body) => {
    const messages = await refusal(create(body));
    expect(messages.join(' ')).toContain('title');
  });

  it('counts the title AFTER trimming: 100 ok', async () => {
    await expect(
      create({ ...VALID, title: `  ${'ก'.repeat(100)}  ` }),
    ).resolves.toMatchObject({ title: 'ก'.repeat(100) });
  });

  it.each([
    ['a missing text', { title: 't' }],
    ['an empty text', { ...VALID, text: '' }],
    ['a whitespace-only text', { ...VALID, text: ' \n ' }],
    ['a null text', { ...VALID, text: null }],
    ['a 1001-character text', { ...VALID, text: 'ข'.repeat(1001) }],
  ])('refuses %s', async (_label, body) => {
    const messages = await refusal(create(body));
    expect(messages.join(' ')).toContain('text');
  });

  it('counts the text AFTER trimming: 1000 ok', async () => {
    await expect(
      create({ ...VALID, text: ` ${'ข'.repeat(1000)} ` }),
    ).resolves.toMatchObject({ text: 'ข'.repeat(1000) });
  });

  it.each([0, 9999, 42])('accepts sortOrder %p', async (sortOrder) => {
    await expect(create({ ...VALID, sortOrder })).resolves.toMatchObject({
      sortOrder,
    });
  });

  it.each([
    ['-1', -1],
    ['10000', 10000],
    ['the JSON string "3" (no coercion)', '3'],
    ['a fraction 1.5', 1.5],
    ['null', null],
  ])('refuses sortOrder %s', async (_label, sortOrder) => {
    const messages = await refusal(create({ ...VALID, sortOrder }));
    expect(messages.join(' ')).toContain('sortOrder');
  });

  it.each([
    ['id', 'canned_reply_chosen'],
    ['createdAt', '2026-09-22T00:00:00.000Z'],
    ['updatedAt', '2026-09-22T00:00:00.000Z'],
    ['foo', 1],
  ])('refuses a body containing `%s`', async (key, value) => {
    const messages = await refusal(create({ ...VALID, [key]: value }));
    expect(messages.join(' ')).toContain(`property ${key} should not exist`);
  });
});

describe('UpdateCannedReplyDto (through the global ValidationPipe)', () => {
  it('lets an empty body through the pipe — the SERVICE refuses it with a coded 400', async () => {
    const dto = await update({});
    expect(dto.title).toBeUndefined();
    expect(dto.text).toBeUndefined();
    expect(dto.sortOrder).toBeUndefined();
  });

  it('accepts any single field, trimmed', async () => {
    await expect(update({ title: ' ใหม่ ' })).resolves.toMatchObject({
      title: 'ใหม่',
    });
    await expect(update({ text: ' ใหม่ ' })).resolves.toMatchObject({
      text: 'ใหม่',
    });
    await expect(update({ sortOrder: 0 })).resolves.toMatchObject({
      sortOrder: 0,
    });
  });

  it.each(['title', 'text', 'sortOrder'])(
    'refuses %s: null — not PartialType',
    async (key) => {
      const messages = await refusal(update({ [key]: null }));
      expect(messages.join(' ')).toContain(key);
    },
  );

  it.each([
    ['a blank title', { title: '   ' }],
    ['a 101-character title', { title: 'x'.repeat(101) }],
    ['a blank text', { text: '' }],
    ['a 1001-character text', { text: 'x'.repeat(1001) }],
    ['sortOrder -1', { sortOrder: -1 }],
    ['sortOrder 10000', { sortOrder: 10000 }],
    ['sortOrder "3"', { sortOrder: '3' }],
    ['sortOrder 1.5', { sortOrder: 1.5 }],
    ['an unknown key', { foo: 1 }],
  ])('refuses %s', async (_label, body) => {
    await refusal(update(body));
  });
});
