import { Prisma } from '@prisma/client';
import { isLockNotAvailable } from './prisma-tx.util';

/**
 * `isLockNotAvailable` (design S-4). These hand-built errors only prove the shapes we expect; the
 * e2e lock test in `test/announcements-send.e2e-spec.ts` is the proof against real Postgres.
 */

/** What Prisma 7 + `@prisma/adapter-pg` throw for a failed `$queryRaw` (read from the runtime). */
const rawQueryFailure = (sqlstate: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `Raw query failed. Code: \`${sqlstate}\`. Message: \`${message}\``,
    {
      code: 'P2010',
      clientVersion: '7.8.0',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            kind: 'postgres',
            code: sqlstate,
            originalCode: sqlstate,
            originalMessage: message,
          },
        },
      },
    },
  );

describe('isLockNotAvailable', () => {
  it('true for Prisma P2010 carrying SQLSTATE 55P03', () => {
    expect(
      isLockNotAvailable(
        rawQueryFailure(
          '55P03',
          'could not obtain lock on row in relation "announcements"',
        ),
      ),
    ).toBe(true);
  });

  it('true via meta.driverAdapterError.cause.originalCode alone (message reworded)', () => {
    const e = rawQueryFailure('55P03', 'reworded');
    Object.defineProperty(e, 'message', { value: 'something else' });
    expect(isLockNotAvailable(e)).toBe(true);
  });

  it('true for a bare { cause: { originalCode: 55P03 } }', () => {
    expect(isLockNotAvailable({ cause: { originalCode: '55P03' } })).toBe(true);
  });

  it('true when only Postgres’ message text is present on the chain', () => {
    expect(
      isLockNotAvailable(
        new Error('wrapped', {
          cause: new Error('could not obtain lock on row in relation "x"'),
        }),
      ),
    ).toBe(true);
  });

  it('false for P2010 with another SQLSTATE (40001)', () => {
    expect(
      isLockNotAvailable(
        rawQueryFailure('40001', 'could not serialize access'),
      ),
    ).toBe(false);
  });

  it('false for P2002 (unique violation)', () => {
    expect(
      isLockNotAvailable(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.8.0',
        }),
      ),
    ).toBe(false);
  });

  it('false for null, a string, and a plain Error', () => {
    expect(isLockNotAvailable(null)).toBe(false);
    expect(isLockNotAvailable('55P03')).toBe(false);
    expect(isLockNotAvailable(new Error('boom'))).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isLockNotAvailable(a)).toBe(false);
  });
});
