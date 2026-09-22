import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AnnouncementAudience,
  AnnouncementFormat,
  AnnouncementStatus,
  AppAccess,
  Prisma,
} from '@prisma/client';
import { bangkokClock, thaiShortDate } from '../bookings/booking-notifier';
import {
  isLockNotAvailable,
  mapTransactionError,
} from '../common/prisma-tx.util';
import {
  buildAnnouncementCard,
  buildAnnouncementText,
} from '../line/announcement-card';
import { classifyLineError } from '../line/line-call-error';
import { LINE_USER_ID_PATTERN } from '../line/line.constants';
import { toNotificationPreferences } from '../line/line-user.service';
import { LineService, type MulticastFailure } from '../line/line.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANNOUNCEMENT_ALREADY_SENT,
  ANNOUNCEMENT_BODY_REQUIRED,
  ANNOUNCEMENT_DEPARTMENT_INVALID,
  ANNOUNCEMENT_DEPARTMENT_NOT_ALLOWED,
  ANNOUNCEMENT_DEPARTMENT_REQUIRED,
  ANNOUNCEMENT_LINE_BOT_INFO_UNAVAILABLE,
  ANNOUNCEMENT_LINE_NOT_CONFIGURED,
  ANNOUNCEMENT_LINE_RATE_LIMITED,
  ANNOUNCEMENT_LINE_SEND_FAILED,
  ANNOUNCEMENT_NO_RECIPIENTS_FOUND,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_PARTIALLY_SENT,
  ANNOUNCEMENT_SEND_DEADLINE_MS,
  ANNOUNCEMENT_SEND_IN_PROGRESS,
  ANNOUNCEMENT_SEND_TX_TIMEOUT_MS,
  ANNOUNCEMENT_SENT_IMMUTABLE,
  ANNOUNCEMENT_UPDATE_EMPTY,
  type AnnouncementStatusFilter,
} from './announcements.constants';
import type { AnnouncementErrorCode } from './dto/announcement-error.dto';
import type { ListAnnouncementsQueryDto } from './dto/announcement-query.dto';
import type {
  AnnouncementDto,
  PaginatedAnnouncementsResponseDto,
} from './dto/announcement-response.dto';
import type {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement-write.dto';
import type { LineBotInfoDto } from './dto/line-bot-info.dto';

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

/** What the send reads under the lock (design §2 step 4) — typed Prisma decoding, not the raw SELECT. */
const SEND_SELECT = {
  title: true,
  body: true,
  format: true,
  audience: true,
  departmentId: true,
  updatedAt: true,
} satisfies Prisma.AnnouncementSelect;

/** A Nest exception class whose first argument becomes the response body when it is an object. */
type HttpExceptionClass = new (objectOrError?: unknown) => HttpException;

/**
 * An exception whose body is the house `{ statusCode, error, message }` plus `code` (design S-6), and
 * `acceptedCount`/`targetedCount` on a partial send. The house fields come from Nest itself, so the
 * shape cannot drift from every other error body.
 */
function codedError(
  Exception: HttpExceptionClass,
  code: AnnouncementErrorCode,
  message: string,
  extra: { acceptedCount?: number; targetedCount?: number } = {},
): HttpException {
  const base = new Exception(message).getResponse() as Record<string, unknown>;
  return new Exception({ ...base, code, ...extra });
}

/** D-C — nothing was accepted, so the send rolls back; this is its answer. */
function lineSendError(kind: MulticastFailure['kind']): HttpException {
  switch (kind) {
    case 'NOT_CONFIGURED':
      return codedError(
        ServiceUnavailableException,
        'LINE_NOT_CONFIGURED',
        ANNOUNCEMENT_LINE_NOT_CONFIGURED,
      );
    case 'RATE_LIMITED':
      return codedError(
        ServiceUnavailableException,
        'LINE_RATE_LIMITED',
        ANNOUNCEMENT_LINE_RATE_LIMITED,
      );
    default:
      return codedError(
        BadGatewayException,
        'LINE_SEND_FAILED',
        ANNOUNCEMENT_LINE_SEND_FAILED,
      );
  }
}

/**
 * `ประกาศและข่าวสาร` — persistence + CRUD (`ANNOUNCE-API-1`) and the LINE send (`ANNOUNCE-API-2`).
 * `send` is the ONLY writer of `SENT` / `sentAt` / `sentCount`.
 *
 * 🔴 PDPA: `title` / `body` are staff-authored free text that may name people, and LINE user ids are
 * personal data. None of them is ever logged or interpolated into an exception message — log lines
 * carry ids of rows, counts, chunk indexes and LINE error kinds only.
 */
@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
  ) {}

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
   * `POST /announcements/:id/send` — the one DRAFT → SENT transition (`ANNOUNCE-API-2`, D-A…D-E,
   * design §2). One interactive transaction, holding the row lock for the whole LINE call:
   *
   *   1. `SELECT … FOR UPDATE NOWAIT` — `55P03` (someone else holds the row) → 409 `SEND_IN_PROGRESS`.
   *   2. No row → 404. 3. Already `SENT` → 409 `ALREADY_SENT` (also the race loser after a commit).
   *   4. Read the content under the lock. 5. Blank body → 400. 6. DEPARTMENT with a null, missing or
   *      soft-deleted department → 400 (the reserved flag is NOT re-checked: it governs authoring).
   *   7. Recipients (see {@link resolveRecipients}); none → 400, and no LINE call.
   *   8. Multicast. Nothing accepted → throw the mapped 502/503: the rollback leaves the row DRAFT.
   *   9. Something accepted → write SENT, `sentAt`, `sentCount = accepted` and RETURN — a partial send
   *      must COMMIT, so its 502 is raised only after `$transaction` has resolved.
   *
   * Phase 1's PATCH/DELETE write `WHERE status = DRAFT`, so they block on this lock and then match 0
   * rows → 409: content cannot change during a send (D-A.6).
   */
  async send(id: string, actorId: string): Promise<AnnouncementDto> {
    // Captured OUTSIDE the callback so the catch can tell "LINE accepted, then the write failed".
    let acceptedByLine = 0;

    const { saved, outcome } = await this.prisma
      .$transaction(
        async (tx) => {
          const start = Date.now();

          let locked: { status: AnnouncementStatus }[];
          try {
            // Parameterised tagged template — `id` is a bound value, never spliced into the SQL.
            locked = await tx.$queryRaw<{ status: AnnouncementStatus }[]>`
              SELECT "status" FROM "announcements" WHERE "id" = ${id} FOR UPDATE NOWAIT`;
          } catch (e) {
            if (isLockNotAvailable(e)) {
              throw codedError(
                ConflictException,
                'ANNOUNCEMENT_SEND_IN_PROGRESS',
                ANNOUNCEMENT_SEND_IN_PROGRESS,
              );
            }
            throw e;
          }
          if (locked.length === 0) {
            throw codedError(
              NotFoundException,
              'ANNOUNCEMENT_NOT_FOUND',
              ANNOUNCEMENT_NOT_FOUND,
            );
          }
          if (locked[0].status === AnnouncementStatus.SENT) {
            throw codedError(
              ConflictException,
              'ANNOUNCEMENT_ALREADY_SENT',
              ANNOUNCEMENT_ALREADY_SENT,
            );
          }

          const row = await tx.announcement.findUniqueOrThrow({
            where: { id },
            select: SEND_SELECT,
          });
          if (row.body.trim() === '') {
            throw codedError(
              BadRequestException,
              'ANNOUNCEMENT_BODY_REQUIRED',
              ANNOUNCEMENT_BODY_REQUIRED,
            );
          }
          // `null` = audience ALL. Only a validated, live department id narrows the recipients.
          let departmentId: number | null = null;
          if (row.audience === AnnouncementAudience.DEPARTMENT) {
            const department =
              row.departmentId === null
                ? null
                : await tx.department.findFirst({
                    where: { id: row.departmentId, deletedAt: null },
                    select: { id: true },
                  });
            if (!department) {
              throw codedError(
                BadRequestException,
                'ANNOUNCEMENT_DEPARTMENT_INVALID',
                ANNOUNCEMENT_DEPARTMENT_INVALID,
              );
            }
            departmentId = department.id;
          }

          const to = await this.resolveRecipients(tx, id, departmentId);
          if (to.length === 0) {
            throw codedError(
              BadRequestException,
              'NO_RECIPIENTS_FOUND',
              ANNOUNCEMENT_NO_RECIPIENTS_FOUND,
            );
          }

          // ONE instant: the card's timestamp and `sentAt` are the same Date (design S-8).
          const now = new Date();
          const message =
            row.format === AnnouncementFormat.FLEX
              ? buildAnnouncementCard({
                  title: row.title,
                  body: row.body,
                  sentAtText: `${thaiShortDate(now)} ${bangkokClock(now)} น.`,
                })
              : buildAnnouncementText(row.title, row.body);

          const result = await this.line.multicast(to, [message], {
            retryKeySeed: `${id}|${row.updatedAt.toISOString()}`,
            deadlineAt: start + ANNOUNCEMENT_SEND_DEADLINE_MS,
          });
          acceptedByLine = result.acceptedCount;

          if (result.acceptedCount === 0) {
            // D-C: the first chunk failed after its retry. Throwing rolls back — the row stays DRAFT.
            const kind = result.failure?.kind ?? 'TRANSIENT';
            this.logger.warn(
              `Announcement not sent id=${id} kind=${kind} status=${result.failure?.status ?? null} targeted=${result.targetedCount}`,
            );
            throw lineSendError(kind);
          }

          // A plain `update` is correct: this transaction holds the row lock.
          const written = await tx.announcement.update({
            where: { id },
            data: {
              status: AnnouncementStatus.SENT,
              sentAt: now,
              sentCount: result.acceptedCount,
            },
            select: ANNOUNCEMENT_SELECT,
          });
          // 🔴 RETURN, never throw, on a partial send: throwing here would roll back the SENT write.
          return { saved: written, outcome: result };
        },
        { timeout: ANNOUNCEMENT_SEND_TX_TIMEOUT_MS },
      )
      .catch((e: unknown) => {
        if (!(e instanceof HttpException) && acceptedByLine > 0) {
          // D-A's documented residual: LINE has the message, the row does not say so. A resend within
          // 24 h reuses the retry keys (409 → accepted); after that it would deliver twice.
          this.logger.error(
            `LINE accepted recipients but the SENT write did not commit; row left DRAFT. id=${id} accepted=${acceptedByLine}`,
          );
        }
        return mapTransactionError(e);
      });

    if (outcome.failure !== null) {
      this.logger.warn(
        `Announcement partially sent id=${id} accepted=${outcome.acceptedCount} targeted=${outcome.targetedCount} failedChunk=${outcome.failure.chunkIndex} kind=${outcome.failure.kind} by=${actorId}`,
      );
      throw codedError(
        BadGatewayException,
        'ANNOUNCEMENT_PARTIALLY_SENT',
        ANNOUNCEMENT_PARTIALLY_SENT,
        {
          acceptedCount: outcome.acceptedCount,
          targetedCount: outcome.targetedCount,
        },
      );
    }

    this.logger.log(
      `Announcement sent id=${id} recipients=${saved.sentCount} requests=${outcome.requestCount} by=${actorId}`,
    );
    return toAnnouncementDto(saved);
  }

  /**
   * `GET /announcements/line-bot-info` (D-G) — the OA the send goes out from. No cache (D-I).
   *
   * Every failure is a 503 with a `code`, never a 500: `LINE_NOT_CONFIGURED` for a missing or rejected
   * token, `LINE_BOT_INFO_UNAVAILABLE` for anything else. Logs carry kind and status only.
   */
  async getLineBotInfo(): Promise<LineBotInfoDto> {
    try {
      const info = await this.line.getBotInfo();
      return {
        basicId: info.basicId,
        displayName: info.displayName,
        pictureUrl: info.pictureUrl,
        chatMode: info.chatMode,
      };
    } catch (err) {
      const e = classifyLineError(err);
      this.logger.warn(
        `LINE bot info unavailable kind=${e.kind} status=${e.status}`,
      );
      throw e.kind === 'NOT_CONFIGURED'
        ? codedError(
            ServiceUnavailableException,
            'LINE_NOT_CONFIGURED',
            ANNOUNCEMENT_LINE_NOT_CONFIGURED,
          )
        : codedError(
            ServiceUnavailableException,
            'LINE_BOT_INFO_UNAVAILABLE',
            ANNOUNCEMENT_LINE_BOT_INFO_UNAVAILABLE,
          );
    }
  }

  /**
   * The LINE `U…` ids an announcement goes to, in `LineUser.id` order (D-B: deterministic chunks):
   * `ALLOWED`, not soft-deleted, and — for DEPARTMENT — holding a live registration in that department.
   *
   * Two filters run here rather than in SQL:
   * - **D-J opt-out**, through the SAME helper and the SAME `settings` select as
   *   `booking-notifier.recipientOf`: a missing row or a malformed value means "on". A JSON-path
   *   `where` would re-implement that fallback differently.
   * - **A malformed `lineUserId` is skipped** (design S-5): one bad id fails LINE's whole request.
   *
   * Counts only in the log line — never an id.
   *
   * @param departmentId the VALIDATED department of a DEPARTMENT announcement; `null` for audience ALL.
   */
  private async resolveRecipients(
    tx: Prisma.TransactionClient,
    id: string,
    departmentId: number | null,
  ): Promise<string[]> {
    const users = await tx.lineUser.findMany({
      where: {
        access: AppAccess.ALLOWED,
        deletedAt: null,
        lineUserId: { not: '' },
        ...(departmentId !== null
          ? { registration: { is: { deletedAt: null, departmentId } } }
          : {}),
      },
      select: {
        lineUserId: true,
        settings: { select: { notifications: true } },
      },
      orderBy: { id: 'asc' },
    });

    const optedIn = users.filter(
      (u) => toNotificationPreferences(u.settings?.notifications).announcements,
    );
    const to = optedIn
      .filter((u) => LINE_USER_ID_PATTERN.test(u.lineUserId))
      .map((u) => u.lineUserId);

    this.logger.log(
      `Announcement recipients id=${id} eligible=${users.length} optedOut=${users.length - optedIn.length} malformed=${optedIn.length - to.length} targeted=${to.length}`,
    );
    return to;
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
