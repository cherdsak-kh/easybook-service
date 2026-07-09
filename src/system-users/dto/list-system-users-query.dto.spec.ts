import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { ListSystemUsersQueryDto } from './list-system-users-query.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const META: ArgumentMetadata = {
  type: 'query',
  metatype: ListSystemUsersQueryDto,
};

const validate = (query: unknown): Promise<ListSystemUsersQueryDto> =>
  pipe.transform(query, META) as Promise<ListSystemUsersQueryDto>;

describe('ListSystemUsersQueryDto (AC-38, AC-39)', () => {
  it('defaults to page=1, limit=20 when absent — the field initializers survive transform', async () => {
    await expect(validate({})).resolves.toMatchObject({ page: 1, limit: 20 });
  });

  it('coerces numeric strings from the query string', async () => {
    await expect(validate({ page: '3', limit: '50' })).resolves.toMatchObject({
      page: 3,
      limit: 50,
    });
  });

  it('accepts a page beyond the last page (the service answers 200 with an empty list)', async () => {
    await expect(validate({ page: '999' })).resolves.toMatchObject({
      page: 999,
      limit: 20,
    });
  });

  it.each([
    ['page=0', { page: '0' }],
    ['limit=0', { limit: '0' }],
    ['limit=101', { limit: '101' }],
    ['page=abc', { page: 'abc' }],
    ['page=1.5', { page: '1.5' }],
    ['page=-1', { page: '-1' }],
    ['an unknown query parameter', { foo: '1' }],
  ])('rejects %s with a 400', async (_label, query) => {
    await expect(validate(query)).rejects.toMatchObject({ status: 400 });
  });

  it('accepts the boundary values limit=1 and limit=100', async () => {
    await expect(validate({ limit: '1' })).resolves.toMatchObject({ limit: 1 });
    await expect(validate({ limit: '100' })).resolves.toMatchObject({
      limit: 100,
    });
  });
});
