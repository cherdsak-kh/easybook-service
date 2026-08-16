import { SystemRole } from '@prisma/client';
import {
  PUBLIC_FIELDS,
  toSystemUserDto,
  type PublicSystemUser,
} from './system-users.fields';

/**
 * Tripwires for the shared public projection.
 *
 * `PUBLIC_FIELDS` is read by `SessionGuard` (every authenticated request) and by every
 * `SystemUsersService` query alike, so a careless widening here leaks from ten endpoints at once.
 * These assertions are written against the CONSTANT, not against a hand-copied literal, so they
 * fail the moment the select drifts.
 */

const creator = { id: 'sa-0', firstName: 'Somsri', lastName: 'Systemadmin' };

const baseRow: PublicSystemUser = {
  id: 'u-1',
  email: 'ada@easybook.local',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: SystemRole.VIEWER,
  department: { id: 7, name: 'IT' },
  personnelRole: { id: 9, name: 'Director' },
  mustChangePassword: false,
  phoneNumber: null,
  profilePictureUrl: null,
  isActive: true,
  lastLoginAt: null,
  lineUserId: null,
  createdAt: new Date('2026-07-01T10:00:00.000Z'),
  createdBy: creator,
  updatedAt: new Date('2026-07-26T20:42:00.000Z'),
};

describe('system-users.fields', () => {
  describe('PUBLIC_FIELDS — the createdBy projection', () => {
    const createdBy = PUBLIC_FIELDS.createdBy as {
      select: Record<string, unknown>;
    } & Record<string, unknown>;

    it('T13 — selects EXACTLY { id, firstName, lastName } on the creator', () => {
      expect(Object.keys(createdBy.select).sort()).toEqual([
        'firstName',
        'id',
        'lastName',
      ]);
    });

    it.each(['email', 'role', 'deletedAt', 'passwordHash', 'isActive'])(
      'T13 — the creator projection never carries `%s`',
      (field) => {
        // `email` is a login identifier (phishing surface) and `role` is reconnaissance — both are
        // excluded deliberately, not by oversight. `deletedAt` is the standing AC-32 rule: the
        // nested object must not become a second way for it to reach `GET /auth/system/me`.
        expect(Object.keys(createdBy.select)).not.toContain(field);
      },
    );

    it('T14 — the creator select has NO `where` key of any kind (DD-4)', () => {
      // `createdById` is HISTORY, not an identity read: a SOFT-DELETED creator must still resolve,
      // forever. Adding `where: { deletedAt: null }` here — or resolving the creator with a second
      // `findFirst({ id, deletedAt: null })`, which is the correct idiom EVERYWHERE ELSE in this
      // service — would return null for a perfectly valid audit row.
      expect(Object.keys(createdBy)).toEqual(['select']);
      expect(createdBy).not.toHaveProperty('where');
    });

    it('T15 — the raw FK `createdById` is NOT selected: the nested object already carries `id`', () => {
      // A raw FK alongside the object would be a second, unspecified field for `gen:api` to emit.
      expect(Object.keys(PUBLIC_FIELDS)).not.toContain('createdById');
    });

    it('carries `updatedAt`, and still carries no password digest and no `deletedAt`', () => {
      expect(Object.keys(PUBLIC_FIELDS)).toContain('updatedAt');
      expect(Object.keys(PUBLIC_FIELDS)).not.toContain('passwordHash');
      expect(Object.keys(PUBLIC_FIELDS)).not.toContain('deletedAt');
    });
  });

  describe('toSystemUserDto', () => {
    it('maps the creator field by field, never by spreading the row', () => {
      const dto = toSystemUserDto(baseRow);
      expect(dto.createdBy).toEqual({
        id: 'sa-0',
        firstName: 'Somsri',
        lastName: 'Systemadmin',
      });
    });

    it('T16 — maps a null creator to null (the seeded first SUPER_ADMIN)', () => {
      const dto = toSystemUserDto({ ...baseRow, createdBy: null });
      expect(dto.createdBy).toBeNull();
    });

    it('T17 — a SOFT-DELETED creator is mapped normally, never dropped (DD-4)', () => {
      // The relation traversal follows the FK unconditionally, so a deleted creator arrives here as
      // an ordinary payload. Nothing in the mapper may second-guess that.
      const dto = toSystemUserDto({
        ...baseRow,
        createdBy: { id: 'sa-gone', firstName: 'Deleted', lastName: 'Creator' },
      });
      expect(dto.createdBy).toEqual({
        id: 'sa-gone',
        firstName: 'Deleted',
        lastName: 'Creator',
      });
    });

    it('T18 — emits `updatedAt` as a non-null ISO 8601 string', () => {
      const dto = toSystemUserDto(baseRow);
      expect(dto.updatedAt).toBe('2026-07-26T20:42:00.000Z');
      expect(dto.createdAt).toBe('2026-07-01T10:00:00.000Z');
    });

    it('the emitted body carries no `deletedAt` and no digest, nested or not', () => {
      const dto = toSystemUserDto(baseRow);
      expect(JSON.stringify(dto)).not.toContain('deletedAt');
      expect(JSON.stringify(dto)).not.toContain('passwordHash');
      expect(JSON.stringify(dto)).not.toContain('createdById');
    });

    it('emits exactly the DTO key set — additive only, nothing removed or renamed', () => {
      expect(Object.keys(toSystemUserDto(baseRow)).sort()).toEqual(
        [
          'createdAt',
          'createdBy',
          'department',
          'email',
          'firstName',
          'id',
          'isActive',
          'lastLoginAt',
          'lastName',
          'lineUserId',
          'mustChangePassword',
          'personnelRole',
          'phoneNumber',
          'profilePictureUrl',
          'role',
          'updatedAt',
        ].sort(),
      );
    });
  });
});
