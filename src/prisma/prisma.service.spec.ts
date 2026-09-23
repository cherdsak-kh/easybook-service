/**
 * Guards the one line that keeps pg's "client is already executing a query" deprecation away: the
 * adapter's pool must be built out of `SerialQueryClient`. Reverting to a bare
 * `{ connectionString }` still passes every other test — the warning is printed once per process
 * and fails nothing — so this is the only thing that would notice.
 *
 * ⚠️ NO DATABASE IS TOUCHED. `PrismaPg` is the real factory behind a spy, and the client is only
 * constructed: Prisma connects lazily, and `onModuleInit` (which would `$connect`) is never called.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from './prisma.service';
import { SerialQueryClient } from './serial-query-client';

jest.mock('@prisma/adapter-pg', () => {
  const actual =
    jest.requireActual<typeof import('@prisma/adapter-pg')>(
      '@prisma/adapter-pg',
    );
  return {
    ...actual,
    PrismaPg: jest.fn(
      (...args: ConstructorParameters<typeof actual.PrismaPg>) =>
        new actual.PrismaPg(...args),
    ),
  };
});

describe('PrismaService', () => {
  it('builds the adapter pool out of SerialQueryClient', () => {
    new PrismaService();

    expect(PrismaPg).toHaveBeenCalledTimes(1);
    expect(PrismaPg).toHaveBeenCalledWith(
      expect.objectContaining({ Client: SerialQueryClient }),
    );
  });
});
