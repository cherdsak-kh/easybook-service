import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import { UpdateSystemUserDto } from './update-system-user.dto';

/** The exact global pipe from `app.setup.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const META: ArgumentMetadata = { type: 'body', metatype: UpdateSystemUserDto };

const validate = (body: unknown): Promise<UpdateSystemUserDto> =>
  pipe.transform(body, META) as Promise<UpdateSystemUserDto>;

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

describe('UpdateSystemUserDto (through the global ValidationPipe)', () => {
  // AC-60 — the ten forbidden keys, rejected by forbidNonWhitelisted at zero code cost.
  describe('forbidden keys → 400 (AC-60)', () => {
    it.each([
      ['lineUserId', 'clx000'],
      ['password', 'a-long-enough-password'],
      ['passwordHash', '$argon2id$x'],
      ['email', 'ada@easybook.local'],
      ['deletedAt', null],
      ['createdById', 'sa-1'],
      ['id', 'user-1'],
      ['lastLoginAt', '2026-07-08T00:00:00.000Z'],
      ['createdAt', '2026-07-08T00:00:00.000Z'],
      ['updatedAt', '2026-07-08T00:00:00.000Z'],
    ])('rejects a body containing `%s`', async (key, value) => {
      const messages = await messagesOf({ firstName: 'Ada', [key]: value });
      expect(messages.join(' ')).toContain(`property ${key} should not exist`);
    });
  });

  // AC-61 — an empty patch is a 400, so `updatedAt` is never bumped by a no-op UPDATE.
  it('rejects an empty body `{}` (AC-61)', async () => {
    const messages = await messagesOf({});
    expect(messages).toContain('At least one field must be provided.');
  });

  it('accepts a body with exactly one field', async () => {
    await expect(validate({ isActive: false })).resolves.toMatchObject({
      isActive: false,
    });
    await expect(validate({ firstName: 'Ada' })).resolves.toMatchObject({
      firstName: 'Ada',
    });
  });

  // AC-62 — null semantics.
  describe('null semantics (AC-62)', () => {
    it.each(['phoneNumber', 'profilePictureUrl'])(
      'accepts an explicit null on the nullable column `%s` (it clears the value)',
      async (key) => {
        const dto = await validate({ [key]: null });
        expect(dto[key as 'phoneNumber' | 'profilePictureUrl']).toBeNull();
      },
    );

    it.each([
      'firstName',
      'lastName',
      'position',
      'department',
      'role',
      'isActive',
    ])(
      'rejects an explicit null on the NOT NULL column `%s` with a 400, not a 403',
      async (key) => {
        await expect(messagesOf({ [key]: null })).resolves.toEqual(
          expect.arrayContaining([expect.any(String)]),
        );
      },
    );

    it('specifically: `{"role": null}` is a 400 at validation, never reaching the policy (§16.1)', async () => {
      const messages = await messagesOf({ role: null });
      expect(messages.join(' ')).toMatch(/role/i);
    });

    it('leaves absent keys `undefined` so Prisma omits them from the UPDATE', async () => {
      const dto = await validate({ firstName: 'Ada' });
      expect(dto.position).toBeUndefined();
      expect(dto.role).toBeUndefined();
      expect(dto.isActive).toBeUndefined();
      expect(dto.phoneNumber).toBeUndefined();
    });
  });

  describe('field validation', () => {
    it('trims strings before validating, so "   " cannot satisfy a NOT NULL column', async () => {
      await expect(validate({ firstName: '  Ada  ' })).resolves.toMatchObject({
        firstName: 'Ada',
      });
      await expect(messagesOf({ firstName: '   ' })).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('firstName')]),
      );
    });

    it('accepts every valid SystemRole value', async () => {
      for (const role of Object.values(SystemRole)) {
        await expect(validate({ role })).resolves.toMatchObject({ role });
      }
    });

    it('rejects an invalid role value', async () => {
      await expect(messagesOf({ role: 'GOD_MODE' })).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('role')]),
      );
    });

    it('rejects a non-https profilePictureUrl (AC-37)', async () => {
      await expect(
        messagesOf({ profilePictureUrl: 'http://cdn.x.com/a.jpg' }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('profilePictureUrl')]),
      );
      await expect(
        messagesOf({ profilePictureUrl: 'javascript:alert(1)' }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('profilePictureUrl')]),
      );
      await expect(
        validate({ profilePictureUrl: 'https://cdn.x.com/a.jpg' }),
      ).resolves.toMatchObject({
        profilePictureUrl: 'https://cdn.x.com/a.jpg',
      });
    });

    it('accepts real office phone formats and rejects injection-shaped junk', async () => {
      await expect(
        validate({ phoneNumber: '02-123-4567 #101' }),
      ).resolves.toBeDefined();
      await expect(
        messagesOf({ phoneNumber: "0812345678'; DROP--" }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.stringContaining('phoneNumber')]),
      );
    });
  });
});
