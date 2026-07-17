import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { OPTION_NAME_TAKEN, OPTION_NOT_FOUND } from './options.errors';
import { OptionsService } from './options.service';

const ROW = {
  id: 1,
  name: 'Computer Science',
  createdAt: new Date('2026-07-14T10:00:00.000Z'),
  updatedAt: new Date('2026-07-14T10:00:00.000Z'),
};

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: ['name'] },
  });

describe('OptionsService', () => {
  let service: OptionsService;
  const department = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const personnelRole = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OptionsService,
        {
          provide: PrismaService,
          useValue: { department, personnelRole },
        },
      ],
    }).compile();
    service = module.get<OptionsService>(OptionsService);
  });

  describe('list', () => {
    it('returns non-deleted departments ordered name ASC, ISO dates, no deletedAt', async () => {
      department.findMany.mockResolvedValue([ROW]);

      const result = await service.list('department', {
        includeReserved: false,
      });

      expect(department.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null, isSystemReserved: false },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
        orderBy: { name: 'asc' },
      });
      expect(result).toEqual([
        {
          id: 1,
          name: 'Computer Science',
          createdAt: '2026-07-14T10:00:00.000Z',
          updatedAt: '2026-07-14T10:00:00.000Z',
        },
      ]);
    });

    it('routes `personnelRole` to the personnel_roles delegate (never department)', async () => {
      personnelRole.findMany.mockResolvedValue([]);
      await service.list('personnelRole', { includeReserved: false });
      expect(personnelRole.findMany).toHaveBeenCalled();
      expect(department.findMany).not.toHaveBeenCalled();
    });

    // ─────────────── system-reserved options (02_design_log.md §2.2) ───────────────

    it('AC-B4 — includeReserved:false excludes reserved rows via the WHERE clause, not a post-filter', async () => {
      department.findMany.mockResolvedValue([]);
      await service.list('department', { includeReserved: false });

      // The control is the WHERE clause: the caller must never hold a row it may not return.
      expect(department.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null, isSystemReserved: false },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
        orderBy: { name: 'asc' },
      });
    });

    it('AC-B4 — includeReserved:true drops the predicate so a SUPER_ADMIN sees reserved rows', async () => {
      department.findMany.mockResolvedValue([]);
      await service.list('department', { includeReserved: true });

      expect(department.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
        orderBy: { name: 'asc' },
      });
    });

    it('AC-B4 — both option models honour includeReserved identically', async () => {
      personnelRole.findMany.mockResolvedValue([]);
      await service.list('personnelRole', { includeReserved: false });
      expect(personnelRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, isSystemReserved: false },
        }),
      );
    });
  });

  describe('create', () => {
    it('creates and returns the option', async () => {
      department.create.mockResolvedValue(ROW);
      const result = await service.create('department', 'Computer Science');
      expect(department.create).toHaveBeenCalledWith({
        data: { name: 'Computer Science' },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      });
      expect(result.name).toBe('Computer Science');
    });

    it('maps a P2002 (active-name collision) to 409 NAME_TAKEN', async () => {
      department.create.mockRejectedValue(p2002());
      await expect(service.create('department', 'Dup')).rejects.toThrow(
        new ConflictException(OPTION_NAME_TAKEN),
      );
    });
  });

  describe('update', () => {
    it('404s an unknown/soft-deleted id and never writes', async () => {
      department.findFirst.mockResolvedValue(null);
      await expect(service.update('department', 999, 'X')).rejects.toThrow(
        new NotFoundException(OPTION_NOT_FOUND),
      );
      expect(department.update).not.toHaveBeenCalled();
    });

    it('renames an existing option', async () => {
      department.findFirst.mockResolvedValue({ id: 1 });
      department.update.mockResolvedValue({ ...ROW, name: 'Renamed' });
      const result = await service.update('department', 1, 'Renamed');
      expect(department.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { name: 'Renamed' },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      });
      expect(result.name).toBe('Renamed');
    });

    it('maps a rename P2002 to 409 NAME_TAKEN', async () => {
      department.findFirst.mockResolvedValue({ id: 1 });
      department.update.mockRejectedValue(p2002());
      await expect(service.update('department', 1, 'Dup')).rejects.toThrow(
        new ConflictException(OPTION_NAME_TAKEN),
      );
    });

    it('AC-B8 — excludes reserved rows from the target lookup, so renaming one is a 404', async () => {
      // The reserved row is filtered in the WHERE, so the lookup misses and the method 404s exactly
      // as for an unknown id — byte-identical, for EVERY role including SUPER_ADMIN. The method
      // takes no actor at all, which is what makes that guarantee unconditional.
      department.findFirst.mockResolvedValue(null);

      await expect(service.update('department', 1, 'Renamed')).rejects.toThrow(
        new NotFoundException(OPTION_NOT_FOUND),
      );
      expect(department.findFirst).toHaveBeenCalledWith({
        where: { id: 1, deletedAt: null, isSystemReserved: false },
        select: { id: true },
      });
      expect(department.update).not.toHaveBeenCalled();
    });
  });

  describe('softDelete', () => {
    it('404s an unknown/already-deleted id and never writes', async () => {
      personnelRole.findFirst.mockResolvedValue(null);
      await expect(service.softDelete('personnelRole', 999)).rejects.toThrow(
        new NotFoundException(OPTION_NOT_FOUND),
      );
      expect(personnelRole.update).not.toHaveBeenCalled();
    });

    it('sets deletedAt (soft delete), never a hard delete', async () => {
      personnelRole.findFirst.mockResolvedValue({ id: 1 });
      personnelRole.update.mockResolvedValue({ ...ROW });
      await service.softDelete('personnelRole', 1);
      const [arg] = personnelRole.update.mock.calls[0] as [
        { where: Record<string, unknown>; data: { deletedAt: unknown } },
      ];
      expect(arg.where).toEqual({ id: 1 });
      expect(arg.data.deletedAt).toBeInstanceOf(Date);
    });

    it('AC-B8 — excludes reserved rows from the target lookup, so deleting one is a 404', async () => {
      personnelRole.findFirst.mockResolvedValue(null);

      await expect(service.softDelete('personnelRole', 1)).rejects.toThrow(
        new NotFoundException(OPTION_NOT_FOUND),
      );
      expect(personnelRole.findFirst).toHaveBeenCalledWith({
        where: { id: 1, deletedAt: null, isSystemReserved: false },
        select: { id: true },
      });
      expect(personnelRole.update).not.toHaveBeenCalled();
    });
  });
});
