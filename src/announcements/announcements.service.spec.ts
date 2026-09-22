import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AnnouncementAudience,
  AnnouncementFormat,
  AnnouncementStatus,
  Prisma,
} from '@prisma/client';
import { LineService } from '../line/line.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANNOUNCEMENT_DEPARTMENT_INVALID,
  ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
  ANNOUNCEMENT_DEPARTMENT_REQUIRED,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_SENT_IMMUTABLE,
  ANNOUNCEMENT_UPDATE_EMPTY,
} from './announcements.constants';
import {
  ANNOUNCEMENT_SELECT,
  AnnouncementsService,
  announcementListWhere,
  escapeLike,
  toAnnouncementDto,
  type AnnouncementActor,
} from './announcements.service';
import type { ListAnnouncementsQueryDto } from './dto/announcement-query.dto';
import type {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement-write.dto';

const ID = 'clx_announcement_cuid';
const ADMIN: AnnouncementActor = { id: 'clx_admin', includeReserved: false };
const SUPER: AnnouncementActor = { id: 'clx_super', includeReserved: true };

/** Staff-authored free text that must never reach a log line (PDPA). */
const TITLE = 'ประชุมผู้ปกครอง คุณสมชาย ใจดี';
const BODY = 'โทร 081-234-5678 เพื่อยืนยัน';

/** The first argument of a mock's Nth call, typed — keeps the casts in ONE place (lint-safe). */
const callArg = <T>(fn: jest.Mock, call = 0): T =>
  (fn.mock.calls as unknown as unknown[][])[call][0] as T;

/** A row shaped exactly like `ANNOUNCEMENT_SELECT`'s payload. */
const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  title: TITLE,
  body: BODY,
  format: AnnouncementFormat.TEXT,
  status: AnnouncementStatus.DRAFT,
  audience: AnnouncementAudience.ALL,
  sentAt: null as Date | null,
  sentCount: 0,
  createdAt: new Date('2026-09-22T08:00:00.000Z'),
  updatedAt: new Date('2026-09-22T08:05:00.000Z'),
  department: null as { id: number; name: string } | null,
  createdBy: { id: ADMIN.id, firstName: 'วีระ', lastName: 'ทองดี' } as {
    id: string;
    firstName: string;
    lastName: string;
  } | null,
  ...over,
});

/** What `update`/`remove` read first. */
const stored = (
  over: Partial<{
    status: AnnouncementStatus;
    audience: AnnouncementAudience;
    departmentId: number | null;
  }> = {},
) => ({
  status: AnnouncementStatus.DRAFT,
  audience: AnnouncementAudience.ALL,
  departmentId: null,
  ...over,
});

const query = (
  over: Partial<ListAnnouncementsQueryDto> = {},
): ListAnnouncementsQueryDto => ({
  page: 1,
  limit: 10,
  status: 'all',
  ...over,
});

type DeptWhere = Prisma.DepartmentWhereInput;
type CreateArgs = { data: Record<string, unknown> };
type UpdateManyArgs = {
  where: Prisma.AnnouncementWhereInput;
  data: Record<string, unknown>;
};

describe('AnnouncementsService', () => {
  let service: AnnouncementsService;

  const announcement = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  };
  const department = { findFirst: jest.fn() };
  /** The BATCH form: resolves the array of already-issued operations. */
  const $transaction = jest.fn((ops: Promise<unknown>[]) => Promise.all(ops));

  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    announcement.findMany.mockResolvedValue([]);
    announcement.count.mockResolvedValue(0);
    announcement.findUnique.mockResolvedValue(row());
    announcement.create.mockResolvedValue(row());
    announcement.updateMany.mockResolvedValue({ count: 1 });
    announcement.deleteMany.mockResolvedValue({ count: 1 });
    department.findFirst.mockResolvedValue({ id: 3 });
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnnouncementsService,
        {
          provide: PrismaService,
          useValue: { announcement, department, $transaction },
        },
        // CRUD never touches LINE; the send's tests live in `announcements-send.service.spec.ts`.
        { provide: LineService, useValue: {} },
      ],
    }).compile();
    service = module.get(AnnouncementsService);
  });

  afterEach(() => logSpy.mockRestore());

  /** Every log line written so far, joined — for the PDPA assertions. */
  const logged = () =>
    (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');

  // ── LIST ─────────────────────────────────────────────────────────────────────────────────────

  describe('list', () => {
    type FindManyArgs = {
      where: Prisma.AnnouncementWhereInput;
      orderBy: unknown;
      skip: number;
      take: number;
      select: unknown;
    };

    it('newest first with an id tie-break, skip/take from page and limit, one snapshot', async () => {
      announcement.count.mockResolvedValue(45);
      const result = await service.list(query({ page: 3, limit: 20 }));

      const args = callArg<FindManyArgs>(announcement.findMany);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.skip).toBe(40);
      expect(args.take).toBe(20);
      expect(args.select).toBe(ANNOUNCEMENT_SELECT);
      expect(callArg<unknown>(announcement.count)).toEqual({
        where: args.where,
      });
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(result.meta).toEqual({
        page: 3,
        limit: 20,
        total: 45,
        totalPages: 3,
      });
    });

    it('totalPages is 0 when total is 0, and a page past the end is an empty page', async () => {
      const result = await service.list(query({ page: 99 }));
      expect(result).toEqual({
        data: [],
        meta: { page: 99, limit: 10, total: 0, totalPages: 0 },
      });
    });

    it('maps rows to the wire shape', async () => {
      announcement.findMany.mockResolvedValue([row()]);
      announcement.count.mockResolvedValue(1);
      const result = await service.list(query());
      expect(result.data).toEqual([toAnnouncementDto(row())]);
    });
  });

  describe('announcementListWhere', () => {
    it.each([
      ['all', {}],
      ['draft', { status: AnnouncementStatus.DRAFT }],
      ['sent', { status: AnnouncementStatus.SENT }],
    ] as const)('status=%s → %j', (status, where) => {
      expect(announcementListWhere({ status })).toEqual(where);
    });

    it('q is a case-insensitive contains on title ONLY', () => {
      expect(announcementListWhere({ status: 'draft', q: 'Pool' })).toEqual({
        status: AnnouncementStatus.DRAFT,
        title: { contains: 'Pool', mode: 'insensitive' },
      });
    });

    it.each([undefined, '', '   '])(
      'q=%j is no predicate at all, never contains ""',
      (q) => {
        expect(announcementListWhere({ status: 'all', q })).toEqual({});
      },
    );

    it('escapes LIKE metacharacters so % and _ match literally', () => {
      expect(announcementListWhere({ status: 'all', q: '100%_off' })).toEqual({
        title: { contains: '100\\%\\_off', mode: 'insensitive' },
      });
    });
  });

  describe('escapeLike', () => {
    it('escapes backslash, percent and underscore — and nothing else', () => {
      expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
      expect(escapeLike('ประกาศ 2569')).toBe('ประกาศ 2569');
    });
  });

  describe('toAnnouncementDto', () => {
    it('serialises timestamps as ISO strings and passes null relations through', () => {
      const sentAt = new Date('2026-09-23T01:00:00.000Z');
      const dto = toAnnouncementDto(
        row({ department: null, createdBy: null, sentAt }),
      );
      expect(dto.department).toBeNull();
      expect(dto.createdBy).toBeNull();
      expect(dto.sentAt).toBe('2026-09-23T01:00:00.000Z');
      expect(dto.createdAt).toBe('2026-09-22T08:00:00.000Z');
      expect(dto.updatedAt).toBe('2026-09-22T08:05:00.000Z');
      expect(dto).not.toHaveProperty('departmentId');
      expect(dto).not.toHaveProperty('createdById');
    });

    it('sentAt null stays null', () => {
      expect(toAnnouncementDto(row()).sentAt).toBeNull();
    });
  });

  // ── GET ──────────────────────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns the item shape', async () => {
      await expect(service.get(ID)).resolves.toEqual(toAnnouncementDto(row()));
      expect(callArg<unknown>(announcement.findUnique)).toEqual({
        where: { id: ID },
        select: ANNOUNCEMENT_SELECT,
      });
    });

    it('unknown id → 404', async () => {
      announcement.findUnique.mockResolvedValue(null);
      await expect(service.get('nope')).rejects.toThrow(
        new NotFoundException(ANNOUNCEMENT_NOT_FOUND),
      );
    });
  });

  // ── CREATE ───────────────────────────────────────────────────────────────────────────────────

  describe('create', () => {
    const create = (dto: Partial<CreateAnnouncementDto>, actor = ADMIN) =>
      service.create({ title: TITLE, ...dto }, actor);

    it('title only: ALL, no department, body "", author from the actor — and never status/sentAt/sentCount (AC-2, D-1, D-5)', async () => {
      await create({});
      const { data } = callArg<CreateArgs>(announcement.create);
      expect(data).toEqual({
        title: TITLE,
        body: '',
        format: undefined,
        audience: AnnouncementAudience.ALL,
        departmentId: null,
        createdById: ADMIN.id,
      });
      expect(data).not.toHaveProperty('status');
      expect(data).not.toHaveProperty('sentAt');
      expect(data).not.toHaveProperty('sentCount');
      expect(department.findFirst).not.toHaveBeenCalled();
    });

    it('passes body and format through', async () => {
      await create({ body: BODY, format: AnnouncementFormat.FLEX });
      const { data } = callArg<CreateArgs>(announcement.create);
      expect(data.body).toBe(BODY);
      expect(data.format).toBe(AnnouncementFormat.FLEX);
    });

    it('ALL + a numeric departmentId → 400 NOT_ALLOWED, nothing written', async () => {
      await expect(
        create({ audience: AnnouncementAudience.ALL, departmentId: 3 }),
      ).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED),
      );
      expect(announcement.create).not.toHaveBeenCalled();
    });

    it('ALL + departmentId null → persists null', async () => {
      await create({ audience: AnnouncementAudience.ALL, departmentId: null });
      expect(
        callArg<CreateArgs>(announcement.create).data.departmentId,
      ).toBeNull();
    });

    it.each([
      ['omitted', undefined],
      ['null', null],
    ])(
      'DEPARTMENT + departmentId %s → 400 REQUIRED, nothing written',
      async (_label, departmentId) => {
        await expect(
          create({ audience: AnnouncementAudience.DEPARTMENT, departmentId }),
        ).rejects.toThrow(
          new BadRequestException(ANNOUNCEMENT_DEPARTMENT_REQUIRED),
        );
        expect(department.findFirst).not.toHaveBeenCalled();
        expect(announcement.create).not.toHaveBeenCalled();
      },
    );

    it('DEPARTMENT + an unknown or soft-deleted department → 400 INVALID (only ACTIVE rows are looked up)', async () => {
      department.findFirst.mockResolvedValue(null);
      await expect(
        create({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 9 }),
      ).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_INVALID),
      );
      expect(callArg<{ where: DeptWhere }>(department.findFirst).where).toEqual(
        { id: 9, deletedAt: null, isSystemReserved: false },
      );
      expect(announcement.create).not.toHaveBeenCalled();
    });

    it('a reserved department is excluded for an actor without the capability (same 400)', async () => {
      department.findFirst.mockResolvedValue(null);
      await expect(
        create({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 1 }),
      ).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_INVALID),
      );
      expect(
        callArg<{ where: DeptWhere }>(department.findFirst).where,
      ).toHaveProperty('isSystemReserved', false);
    });

    it('a SUPER_ADMIN (includeReserved) may target a reserved department', async () => {
      department.findFirst.mockResolvedValue({ id: 1 });
      await create(
        { audience: AnnouncementAudience.DEPARTMENT, departmentId: 1 },
        SUPER,
      );
      expect(callArg<{ where: DeptWhere }>(department.findFirst).where).toEqual(
        { id: 1, deletedAt: null },
      );
      const { data } = callArg<CreateArgs>(announcement.create);
      expect(data.departmentId).toBe(1);
      expect(data.audience).toBe(AnnouncementAudience.DEPARTMENT);
      expect(data.createdById).toBe(SUPER.id);
    });

    it('logs the id only — never the title or body (PDPA)', async () => {
      await create({ body: BODY });
      expect(logged()).toContain(`id=${ID}`);
      expect(logged()).not.toContain(TITLE);
      expect(logged()).not.toContain(BODY);
    });
  });

  // ── UPDATE ───────────────────────────────────────────────────────────────────────────────────

  describe('update', () => {
    const update = (dto: UpdateAnnouncementDto, actor = ADMIN) =>
      service.update(ID, dto, actor);

    /** First `findUnique` = the pre-write read; later ones = the echo. */
    const storedAs = (s: ReturnType<typeof stored> | null) =>
      announcement.findUnique.mockResolvedValueOnce(s);

    it('an empty patch → 400 UPDATE_EMPTY with no DB call at all (S-2)', async () => {
      await expect(update({})).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_UPDATE_EMPTY),
      );
      expect(announcement.findUnique).not.toHaveBeenCalled();
      expect(announcement.updateMany).not.toHaveBeenCalled();
    });

    it('unknown id → 404, nothing written', async () => {
      storedAs(null);
      await expect(update({ title: 'x' })).rejects.toThrow(
        new NotFoundException(ANNOUNCEMENT_NOT_FOUND),
      );
      expect(announcement.updateMany).not.toHaveBeenCalled();
    });

    it('a SENT row → 409 with no write call (D-2)', async () => {
      storedAs(stored({ status: AnnouncementStatus.SENT }));
      await expect(update({ title: 'x' })).rejects.toThrow(
        new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE),
      );
      expect(department.findFirst).not.toHaveBeenCalled();
      expect(announcement.updateMany).not.toHaveBeenCalled();
    });

    it('the conditional write matched nothing → 409 (S-6)', async () => {
      storedAs(stored());
      announcement.updateMany.mockResolvedValue({ count: 0 });
      await expect(update({ title: 'x' })).rejects.toThrow(
        new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE),
      );
    });

    it('writes with status DRAFT in the predicate and answers with a re-read', async () => {
      storedAs(stored());
      const result = await update({ title: 'ใหม่', body: '' });

      const args = callArg<UpdateManyArgs>(announcement.updateMany);
      expect(args.where).toEqual({ id: ID, status: AnnouncementStatus.DRAFT });
      expect(args.data).toEqual({
        title: 'ใหม่',
        body: '',
        format: undefined,
        audience: AnnouncementAudience.ALL,
        departmentId: null,
      });
      expect(announcement.findUnique).toHaveBeenCalledTimes(2);
      expect(result).toEqual(toAnnouncementDto(row()));
    });

    it('{ audience: DEPARTMENT } alone inherits the stored department and re-validates it', async () => {
      storedAs(
        stored({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 3 }),
      );
      await update({ audience: AnnouncementAudience.DEPARTMENT });
      expect(callArg<{ where: DeptWhere }>(department.findFirst).where).toEqual(
        { id: 3, deletedAt: null, isSystemReserved: false },
      );
      expect(
        callArg<UpdateManyArgs>(announcement.updateMany).data.departmentId,
      ).toBe(3);
    });

    it('{ audience: DEPARTMENT } on an ALL row with no stored department → 400 REQUIRED', async () => {
      storedAs(stored());
      await expect(
        update({ audience: AnnouncementAudience.DEPARTMENT }),
      ).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_REQUIRED),
      );
      expect(announcement.updateMany).not.toHaveBeenCalled();
    });

    it('{ audience: ALL } on a DEPARTMENT row clears the department without the client sending null', async () => {
      storedAs(
        stored({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 3 }),
      );
      await update({ audience: AnnouncementAudience.ALL });
      const { data } = callArg<UpdateManyArgs>(announcement.updateMany);
      expect(data.audience).toBe(AnnouncementAudience.ALL);
      expect(data.departmentId).toBeNull();
      expect(department.findFirst).not.toHaveBeenCalled();
    });

    it('{ audience: ALL, departmentId: 3 } → 400 NOT_ALLOWED', async () => {
      storedAs(
        stored({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 3 }),
      );
      await expect(
        update({ audience: AnnouncementAudience.ALL, departmentId: 3 }),
      ).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED),
      );
      expect(announcement.updateMany).not.toHaveBeenCalled();
    });

    it('{ departmentId: 5 } on an ALL row → 400 NOT_ALLOWED (merged audience is ALL)', async () => {
      storedAs(stored());
      await expect(update({ departmentId: 5 })).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED),
      );
    });

    it('{ departmentId: null } on a DEPARTMENT row → 400 REQUIRED', async () => {
      storedAs(
        stored({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 3 }),
      );
      await expect(update({ departmentId: null })).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_REQUIRED),
      );
    });

    it('a new departmentId on a DEPARTMENT row is validated and written', async () => {
      storedAs(
        stored({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 3 }),
      );
      department.findFirst.mockResolvedValue({ id: 7 });
      await update({ departmentId: 7 });
      expect(
        callArg<{ where: DeptWhere }>(department.findFirst).where,
      ).toHaveProperty('id', 7);
      expect(
        callArg<UpdateManyArgs>(announcement.updateMany).data.departmentId,
      ).toBe(7);
    });

    it('a title-only patch on a DEPARTMENT draft whose department is now soft-deleted → 400 INVALID', async () => {
      storedAs(
        stored({ audience: AnnouncementAudience.DEPARTMENT, departmentId: 3 }),
      );
      department.findFirst.mockResolvedValue(null);
      await expect(update({ title: 'แก้หัวข้อ' })).rejects.toThrow(
        new BadRequestException(ANNOUNCEMENT_DEPARTMENT_INVALID),
      );
      expect(announcement.updateMany).not.toHaveBeenCalled();
    });

    it('logs the id only — never the title (PDPA)', async () => {
      storedAs(stored());
      await update({ title: TITLE });
      expect(logged()).toContain(`id=${ID}`);
      expect(logged()).not.toContain(TITLE);
    });
  });

  // ── DELETE ───────────────────────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deletes a DRAFT with status DRAFT in the predicate', async () => {
      announcement.findUnique.mockResolvedValueOnce(stored());
      await expect(service.remove(ID, ADMIN.id)).resolves.toBeUndefined();
      expect(callArg<unknown>(announcement.deleteMany)).toEqual({
        where: { id: ID, status: AnnouncementStatus.DRAFT },
      });
    });

    it('unknown id → 404, nothing deleted', async () => {
      announcement.findUnique.mockResolvedValueOnce(null);
      await expect(service.remove(ID, ADMIN.id)).rejects.toThrow(
        new NotFoundException(ANNOUNCEMENT_NOT_FOUND),
      );
      expect(announcement.deleteMany).not.toHaveBeenCalled();
    });

    it('a SENT row → 409 with no delete call (D-2)', async () => {
      announcement.findUnique.mockResolvedValueOnce(
        stored({ status: AnnouncementStatus.SENT }),
      );
      await expect(service.remove(ID, ADMIN.id)).rejects.toThrow(
        new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE),
      );
      expect(announcement.deleteMany).not.toHaveBeenCalled();
    });

    it('the conditional delete matched nothing → 409 (S-6)', async () => {
      announcement.findUnique.mockResolvedValueOnce(stored());
      announcement.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove(ID, ADMIN.id)).rejects.toThrow(
        new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE),
      );
    });
  });
});
