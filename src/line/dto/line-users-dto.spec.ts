import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { AppAccess } from '@prisma/client';
import { AdminUpdateLineUserRegistrationDto } from './admin-update-line-user-registration.dto';
import { CreateLineUserRegistrationDto } from './create-line-user-registration.dto';
import { ListLineUsersQueryDto } from './list-line-users-query.dto';
import { UpdateLineUserAccessDto } from './update-line-user-access.dto';

/** The exact global pipe from `app.setup.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const runner = <T>(metatype: unknown, type: 'query' | 'body' = 'query') => {
  const META = { type, metatype } as ArgumentMetadata;
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

  // ───────── reason (Reject) — DTO enforces type + max length; required-when-REJECTED is a service rule ─────────

  it('accepts an absent reason with a valid access (reason is optional at the transport layer)', async () => {
    await expect(validate({ access: AppAccess.ALLOWED })).resolves.toEqual({
      access: AppAccess.ALLOWED,
    });
  });

  it('trims a valid reason via @Transform (leading/trailing whitespace stripped)', async () => {
    await expect(
      validate({ access: AppAccess.REJECTED, reason: '  need to fix phone  ' }),
    ).resolves.toMatchObject({
      access: AppAccess.REJECTED,
      reason: 'need to fix phone',
    });
  });

  it('accepts a reason of exactly 500 chars but rejects 501 (boundary)', async () => {
    await expect(
      validate({ access: AppAccess.REJECTED, reason: 'a'.repeat(500) }),
    ).resolves.toMatchObject({ reason: 'a'.repeat(500) });

    const messages = await messagesOf({
      access: AppAccess.REJECTED,
      reason: 'a'.repeat(501),
    });
    expect(messages.join(' ')).toMatch(/reason/);
  });

  it('rejects a non-string reason (@IsString)', async () => {
    const messages = await messagesOf({
      access: AppAccess.REJECTED,
      reason: 5,
    });
    expect(messages.join(' ')).toMatch(/reason/);
  });

  it('does NOT 400 a REJECTED body missing a reason — the required-when-REJECTED rule is a SERVICE concern', async () => {
    // The DTO stays permissive (reason is optional at the transport boundary); the service enforces
    // the mandatory-reason rule for REJECTED. So the pipe must accept a REJECTED body with no reason.
    await expect(
      validate({ access: AppAccess.REJECTED }),
    ).resolves.toMatchObject({ access: AppAccess.REJECTED });
  });
});

describe('CreateLineUserRegistrationDto (through the global ValidationPipe)', () => {
  const { validate, messagesOf } = runner<CreateLineUserRegistrationDto>(
    CreateLineUserRegistrationDto,
    'body',
  );

  const VALID = {
    firstName: 'Somchai',
    lastName: 'Jaidee',
    phone: '081-234-5678',
    departmentId: 1,
    personnelRoleId: 2,
  };

  it('accepts a valid payload and trims string fields (SC-B1)', async () => {
    await expect(
      validate({ ...VALID, firstName: '  Somchai  ' }),
    ).resolves.toMatchObject({ ...VALID, firstName: 'Somchai' });
  });

  it('coerces stringified integer option ids to numbers (@Type(() => Number))', async () => {
    await expect(
      validate({ ...VALID, departmentId: '3', personnelRoleId: '4' }),
    ).resolves.toMatchObject({ departmentId: 3, personnelRoleId: 4 });
  });

  it('rejects a client-supplied lineUserId via forbidNonWhitelisted (impersonation guard)', async () => {
    const messages = await messagesOf({ ...VALID, lineUserId: 'U-evil' });
    expect(messages.join(' ')).toContain(
      'property lineUserId should not exist',
    );
  });

  // `forbidNonWhitelisted` is key-agnostic: every property absent from the DTO is a 400, so this one
  // assertion covers every retired registration key — the free-text `department`/`role` pair AND the
  // personnel-ID field dropped in this sprint (its current spelling is deliberately not written
  // anywhere under src/ or test/, so `studentStaffId`, the same field's earlier name, stands in).
  it('rejects retired registration keys — a stale client gets a 400, never a silent accept', async () => {
    const messages = await messagesOf({
      ...VALID,
      department: 'Computer Science',
      role: 'Student',
      studentStaffId: '6412345678',
    });
    const joined = messages.join(' ');
    expect(joined).toContain('property department should not exist');
    expect(joined).toContain('property role should not exist');
    expect(joined).toContain('property studentStaffId should not exist');
  });

  it.each(['firstName', 'lastName'])(
    'rejects a blank %s (SC-B1/SC-B6)',
    async (field) => {
      const messages = await messagesOf({ ...VALID, [field]: '   ' });
      expect(messages.join(' ')).toMatch(new RegExp(field));
    },
  );

  it.each(['departmentId', 'personnelRoleId'])(
    'rejects a non-integer %s (SC-B6)',
    async (field) => {
      const messages = await messagesOf({ ...VALID, [field]: 'not-a-number' });
      expect(messages.join(' ')).toMatch(new RegExp(field));
    },
  );

  it.each([
    ['a missing required field', { ...VALID, phone: undefined }],
    ['a bad phone', { ...VALID, phone: 'not a phone!!' }],
  ])('rejects %s (AC-B6)', async (_label, body) => {
    await expect(messagesOf(body)).resolves.toBeInstanceOf(Array);
  });
});

describe('AdminUpdateLineUserRegistrationDto (through the global ValidationPipe)', () => {
  const { validate, messagesOf } = runner<AdminUpdateLineUserRegistrationDto>(
    AdminUpdateLineUserRegistrationDto,
    'body',
  );

  const VALID = {
    firstName: 'Somchai',
    lastName: 'Jaidee',
    phone: '081-234-5678',
    departmentId: 1,
    personnelRoleId: 2,
  };

  it('AC-B4 — reuses the create validation by inheritance: accepts a valid payload, trims, coerces ids', async () => {
    await expect(
      validate({
        ...VALID,
        firstName: '  Somchai  ',
        departmentId: '3',
        personnelRoleId: '4',
      }),
    ).resolves.toMatchObject({
      firstName: 'Somchai',
      departmentId: 3,
      personnelRoleId: 4,
    });
  });

  it('AC-B3 — a client-supplied lineUserId is rejected via forbidNonWhitelisted (immutable identity)', async () => {
    const messages = await messagesOf({ ...VALID, lineUserId: 'U-evil' });
    expect(messages.join(' ')).toContain(
      'property lineUserId should not exist',
    );
  });

  it.each(['firstName', 'lastName'])(
    'AC-B4 — rejects a blank %s',
    async (field) => {
      const messages = await messagesOf({ ...VALID, [field]: '   ' });
      expect(messages.join(' ')).toMatch(new RegExp(field));
    },
  );

  it.each([
    ['a missing required field', { ...VALID, phone: undefined }],
    ['a bad phone', { ...VALID, phone: 'not a phone!!' }],
  ])('AC-B4 — rejects %s', async (_label, body) => {
    await expect(messagesOf(body)).resolves.toBeInstanceOf(Array);
  });
});
