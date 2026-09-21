import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AnnouncementAudience,
  AnnouncementStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANNOUNCEMENT_DEPARTMENT_INVALID,
  ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
  ANNOUNCEMENT_DEPARTMENT_REQUIRED,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_SENT_IMMUTABLE,
  ANNOUNCEMENT_UPDATE_EMPTY,
  type AnnouncementStatusFilter,
} from './announcements.constants';
import type { ListAnnouncementsQueryDto } from './dto/announcement-query.dto';
import type {
  AnnouncementDto,
  PaginatedAnnouncementsResponseDto,
} from './dto/announcement-response.dto';
import type {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement-write.dto';

/**
 * What every response renders — list and detail alike (design S-4).
 *
 * Neither nested select carries a `deletedAt` filter: department and creator are resolved as HISTORY
 * (DD-4), so a soft-deleted department or staff member keeps resolving its name. Filtering here would
 * turn an existing row's department into `null` and lie about who the draft targets.
 */
export const ANNOUNCEMENT_SELECT = {
  id: true,
  title: true,
  body: true,
  format: true,
  status: true,
  audience: true,
  sentAt: true,
  sentCount: true,
  createdAt: true,
  updatedAt: true,
  department: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AnnouncementSelect;

type AnnouncementRow = Prisma.AnnouncementGetPayload<{
  select: typeof ANNOUNCEMENT_SELECT;
}>;

/**
 * The acting staff member, as the service needs it: an id to record (D-5) and whether they may
 * target a system-reserved department (design S-5).
 *
 * `includeReserved` is a BOOLEAN, never a role — the role → capability decision is
 * `mayUseSystemReservedOptions` in `system-users.policy.ts` and is taken by the controller.
 */
export interface AnnouncementActor {
  id: string;
  includeReserved: boolean;
}

/** `status` filter → stored status; `all` is "no predicate". */
const STATUS_FILTER: Record<
  AnnouncementStatusFilter,
  AnnouncementStatus | null
> = {
  all: null,
  draft: AnnouncementStatus.DRAFT,
  sent: AnnouncementStatus.SENT,
};

/**
 * `ANNOUNCE-API-1` phase 1 — persistence + CRUD for `ประกาศและข่าวสาร`. NOTHING IS BROADCAST (D-1):
 * there is no LINE push, no send transition, and no writer of `SENT` / `sentAt` / `sentCount`.
 *
 * 🔴 PDPA: `title` / `body` are staff-authored free text that may name people. They are never logged
 * and never interpolated into an exception message — log lines carry ids only.
 */
@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /announcements` — one page and the FILTERED total. Newest first; `id` breaks `createdAt`
   * ties so the order is total and no row repeats or vanishes across pages.
   *
   * The batch `$transaction` under REPEATABLE READ is the `SystemUsersService.list` idiom: the page
   * and the total come from one snapshot, so `meta.total` cannot disagree with `data`.
   */
  async list(
    query: ListAnnouncementsQueryDto,
  ): Promise<PaginatedAnnouncementsResponseDto> {
    const where = announcementListWhere(query);

    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.announcement.findMany({
          where,
          select: ANNOUNCEMENT_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        this.prisma.announcement.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      data: rows.map(toAnnouncementDto),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  /** `GET /announcements/:id` — cuid only; an unknown and a malformed id are both a 404 (AC-7). */
  async get(id: string): Promise<AnnouncementDto> {
    const row = await this.prisma.announcement.findUnique({
      where: { id },
      select: ANNOUNCEMENT_SELECT,
    });
    if (!row) throw new NotFoundException(ANNOUNCEMENT_NOT_FOUND);
    return toAnnouncementDto(row);
  }

  /**
   * `POST /announcements` — ALWAYS a `DRAFT` (D-1). `status`, `sentAt` and `sentCount` come from the
   * column defaults and nowhere else; the author is the session user (D-5).
   *
   * No transaction: the department check is a read and the insert is one write. A department
   * soft-deleted between the two leaves exactly the state the plan already allows ("department
   * soft-deleted after drafting" — readable, and the next PATCH re-validates it).
   */
  async create(
    dto: CreateAnnouncementDto,
    actor: AnnouncementActor,
  ): Promise<AnnouncementDto> {
    const audience = dto.audience ?? AnnouncementAudience.ALL;
    const departmentId = await this.resolveDepartmentId(
      audience,
      dto.departmentId,
      null,
      actor.includeReserved,
    );

    const row = await this.prisma.announcement.create({
      data: {
        title: dto.title,
        body: dto.body ?? '',
        // `undefined` is omitted by Prisma, so an absent format takes the column default (TEXT).
        format: dto.format,
        audience,
        departmentId,
        createdById: actor.id,
      },
      select: ANNOUNCEMENT_SELECT,
    });

    this.logger.log(`Announcement created id=${row.id} by=${actor.id}`);
    return toAnnouncementDto(row);
  }

  /**
   * `PATCH /announcements/:id` — DRAFT only (D-2), in this order (design S-6):
   *
   *   0. No DB: every field absent → 400 `ANNOUNCEMENT_UPDATE_EMPTY` (S-2).
   *   1. Read the row → 404 when absent.
   *   2. `SENT` → 409 `ANNOUNCEMENT_SENT_IMMUTABLE`, nothing written.
   *   3. The audience/department invariant on the MERGED state → 400 (D-3). This runs on EVERY patch
   *      of a DEPARTMENT draft, a title-only one included, which is what makes "department
   *      soft-deleted after drafting" a 400 on the next save.
   *   4. A CONDITIONAL write, `WHERE id AND status = DRAFT`: a phase-2 send racing this edit cannot be
   *      overwritten. `count 0` → 409 (the row was a draft a moment ago; the write did not apply).
   *   5. Re-read and answer 200. A patch whose values equal the stored ones is still a write
   *      (`updatedAt` advances) — there is no "no change" detection.
   */
  async update(
    id: string,
    dto: UpdateAnnouncementDto,
    actor: AnnouncementActor,
  ): Promise<AnnouncementDto> {
    if (
      dto.title === undefined &&
      dto.body === undefined &&
      dto.format === undefined &&
      dto.audience === undefined &&
      dto.departmentId === undefined
    ) {
      throw new BadRequestException(ANNOUNCEMENT_UPDATE_EMPTY);
    }

    const current = await this.prisma.announcement.findUnique({
      where: { id },
      select: { status: true, audience: true, departmentId: true },
    });
    if (!current) throw new NotFoundException(ANNOUNCEMENT_NOT_FOUND);
    if (current.status === AnnouncementStatus.SENT) {
      throw new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE);
    }

    const audience = dto.audience ?? current.audience;
    const departmentId = await this.resolveDepartmentId(
      audience,
      dto.departmentId,
      current.departmentId,
      actor.includeReserved,
    );

    const { count } = await this.prisma.announcement.updateMany({
      where: { id, status: AnnouncementStatus.DRAFT },
      data: {
        title: dto.title,
        body: dto.body,
        format: dto.format,
        audience,
        departmentId,
      },
    });
    if (count === 0) throw new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE);

    this.logger.log(`Announcement updated id=${id} by=${actor.id}`);
    return this.get(id);
  }

  /**
   * `DELETE /announcements/:id` — a HARD delete of a DRAFT (D-2: drafts carry no audit value; there is
   * no soft delete in phase 1). Same order and the same conditional write as `update`.
   */
  async remove(id: string, actorId: string): Promise<void> {
    const current = await this.prisma.announcement.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) throw new NotFoundException(ANNOUNCEMENT_NOT_FOUND);
    if (current.status === AnnouncementStatus.SENT) {
      throw new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE);
    }

    const { count } = await this.prisma.announcement.deleteMany({
      where: { id, status: AnnouncementStatus.DRAFT },
    });
    if (count === 0) throw new ConflictException(ANNOUNCEMENT_SENT_IMMUTABLE);

    this.logger.log(`Announcement deleted id=${id} by=${actorId}`);
  }

  /**
   * D-3 — the ONE place the audience/department invariant is decided (design §5.3), for create and
   * update alike. Returns the `departmentId` to persist.
   *
   * @param sent   what the request carried: `undefined` = omitted, `null` = explicitly none.
   * @param stored the row's current department on PATCH; `null` on POST.
   *
   * - `ALL`: a sent NUMBER is a 400 (forbidden, never silently cleared); omitted or `null` persists
   *   `null` — which is how `DEPARTMENT → ALL` clears it without the client sending `null`.
   * - `DEPARTMENT`: the effective id is the sent one when present, else the stored one. `null` → 400;
   *   otherwise it must be an ACTIVE department, and a reserved one only when `includeReserved`.
   *   Unknown, soft-deleted and reserved-for-this-actor are ONE 400 — no existence oracle (S-5).
   */
  private async resolveDepartmentId(
    audience: AnnouncementAudience,
    sent: number | null | undefined,
    stored: number | null,
    includeReserved: boolean,
  ): Promise<number | null> {
    if (audience === AnnouncementAudience.ALL) {
      if (typeof sent === 'number') {
        throw new BadRequestException(ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED);
      }
      return null;
    }

    const id = sent !== undefined ? sent : stored;
    if (id === null) {
      throw new BadRequestException(ANNOUNCEMENT_DEPARTMENT_REQUIRED);
    }

    const department = await this.prisma.department.findFirst({
      where: {
        id,
        deletedAt: null,
        ...(includeReserved ? {} : { isSystemReserved: false }),
      },
      select: { id: true },
    });
    if (!department) {
      throw new BadRequestException(ANNOUNCEMENT_DEPARTMENT_INVALID);
    }
    return department.id;
  }
}

/**
 * The list `where`: the status filter ANDed with the title search (§5.1). Empty `q` after trimming is
 * no predicate at all, never `contains: ''`.
 */
export function announcementListWhere(
  query: Pick<ListAnnouncementsQueryDto, 'status' | 'q'>,
): Prisma.AnnouncementWhereInput {
  const status = STATUS_FILTER[query.status ?? 'all'];
  const term = query.q?.trim() ?? '';
  return {
    ...(status ? { status } : {}),
    ...(term
      ? { title: { contains: escapeLike(term), mode: 'insensitive' } }
      : {}),
  };
}

/**
 * Escapes the three LIKE metacharacters so `q` matches LITERALLY.
 *
 * 🔴 PRISMA 7 DOES NOT DO THIS FOR `contains`. Verified against the dev database on 2026-09-22:
 * `department.count({ where: { name: { contains: '_' } } })` matched every row while no name held a
 * `_`. The design (§5.1) assumed otherwise. Postgres' default LIKE escape character is the backslash,
 * so a literal backslash is escaped too, or `a\` would escape whatever Prisma appends after it.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Row → wire shape: ISO timestamps, nested relations passed through (already `null` when absent). */
export function toAnnouncementDto(row: AnnouncementRow): AnnouncementDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    format: row.format,
    status: row.status,
    audience: row.audience,
    department: row.department
      ? { id: row.department.id, name: row.department.name }
      : null,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    sentCount: row.sentCount,
    createdBy: row.createdBy
      ? {
          id: row.createdBy.id,
          firstName: row.createdBy.firstName,
          lastName: row.createdBy.lastName,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
