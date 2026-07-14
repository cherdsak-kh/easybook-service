import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { AppAccess } from '@prisma/client';
import { ListLineUsersQueryDto } from './list-line-users-query.dto';
import { UpdateLineUserAccessDto } from './update-line-user-access.dto';

/** The exact global pipe from `app.setup.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const runner = <T>(metatype: unknown) => {
  const META = { type: 'query', metatype } as ArgumentMetadata;
  const validate = (body: unknown): Promise<T> =>
    pipe.transform(body, META) as Promise<T>;
  const messagesOf = async (body: unknown): Promise<string[]> => {
    try {
      await validate(body);
      throw new Error('expected a ValidationPipe rejection');
    } catch (e) {
      const response = (e as { response?: { message?: string[] } }).response;
      if (!response?.message) throw e;
      return response.message;
    }
  };
  return { validate, messagesOf };
};

describe('ListLineUsersQueryDto (through the global ValidationPipe)', () => {
  const { validate, messagesOf } = runner<ListLineUsersQueryDto>(
    ListLineUsersQueryDto,
  );

  it('defaults page=1, limit=20 when absent', async () => {
    await expect(validate({})).resolves.toMatchObject({ page: 1, limit: 20 });
  });

  it('coerces numeric strings and preserves the filters', async () => {
    await expect(
      validate({ page: '2', limit: '50', search: '  Ada ', access: 'BLOCKED' }),
    ).resolves.toMatchObject({
      page: 2,
      limit: 50,
      search: 'Ada', // trimmed
      access: AppAccess.BLOCKED,
    });
  });

  it.each([
    ['limit', '101'],
    ['limit', '0'],
    ['page', '0'],
    ['page', 'abc'],
  ])('rejects %s=%s (AC-B3)', async (key, value) => {
    await expect(messagesOf({ [key]: value })).resolves.toBeInstanceOf(Array);
  });

  it('rejects an unknown query param (AC-B3)', async () => {
    const messages = await messagesOf({ sort: 'name' });
    expect(messages.join(' ')).toContain('property sort should not exist');
  });

  it('rejects an invalid access value (AC-B5)', async () => {
    const messages = await messagesOf({ access: 'NOPE' });
    expect(messages.join(' ')).toMatch(/access/);
  });
});

describe('UpdateLineUserAccessDto (through the global ValidationPipe)', () => {
  const { validate, messagesOf } = runner<UpdateLineUserAccessDto>(
    UpdateLineUserAccessDto,
  );

  it.each([AppAccess.ALLOWED, AppAccess.BLOCKED, AppAccess.PENDING])(
    'accepts access=%s (the design log §7.3 accepts any AppAccess member)',
    async (access) => {
      await expect(validate({ access })).resolves.toEqual({ access });
    },
  );

  it('rejects an empty body — access is required (AC-B11)', async () => {
    const messages = await messagesOf({});
    expect(messages.join(' ')).toMatch(/access/);
  });

  it('rejects a bad enum value (AC-B11)', async () => {
    const messages = await messagesOf({ access: 'MAYBE' });
    expect(messages.join(' ')).toMatch(/access/);
  });

  it('rejects an extra key via forbidNonWhitelisted (AC-B11)', async () => {
    const messages = await messagesOf({ access: AppAccess.ALLOWED, note: 'x' });
    expect(messages.join(' ')).toContain('property note should not exist');
  });
});
