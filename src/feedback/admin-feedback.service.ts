import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FeedbackStatus, FeedbackType, Prisma } from '@prisma/client';
import { mapTransactionError } from '../common/prisma-tx.util';
import { PrismaService } from '../prisma/prisma.service';
import type { ListFeedbackQueryDto } from './dto/admin-feedback-query.dto';
import type {
  AdminFeedbackDetailDto,
  AdminFeedbackListItemDto,
  FeedbackCountsDto,
  PaginatedFeedbackResponseDto,
} from './dto/admin-feedback-response.dto';
import type { UpdateFeedbackDto } from './dto/admin-feedback-write.dto';
import {
  FEEDBACK_NO_CHANGE,
  FEEDBACK_NOT_FOUND,
  FEEDBACK_UPDATE_EMPTY,
  FEEDBACK_VENUE_GENERAL,
} from './feedback.constants';

/**
 * What a list row and a card render.
 *
 * 🔴 `lineUser.lineUserId` — the LINE `U…` subject — IS NEVER SELECTED (AC-13), so it cannot leak
 * into a response by a careless spread. Nothing carries a `deletedAt` filter: venue, registration and
 * options are all resolved as HISTORY (D-8, E-3), the asymmetry every option FK in the schema follows.
 */
export const FEEDBACK_LIST_SELECT = {
  id: true,
  code: true,
  type: true,
  status: true,
  subject: true,
  description: true,
  photos: true,
  createdAt: true,
  venue: { select: { id: true, name: true } },
  lineUser: {
    select: {
      displayName: true,
      pictureUrl: true,
      registration: {
        select: {
          firstName: true,
          lastName: true,
          phone: true,
          department: { select: { name: true } },
          personnelRole: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.FeedbackSelect;

/** The list select plus the log timeline, ASC with a tie-breaker so equal timestamps stay stable. */
export const FEEDBACK_DETAIL_SELECT = {
  ...FEEDBACK_LIST_SELECT,
  logs: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      status: true,
      note: true,
      createdAt: true,
      // HISTORY, not identity: a soft-deleted author still resolves. `null` only after a hard delete.
      author: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.FeedbackSelect;

type ListRow = Prisma.FeedbackGetPayload<{
  select: typeof FEEDBACK_LIST_SELECT;
}>;
type DetailRow = Prisma.FeedbackGetPayload<{
  select: typeof FEEDBACK_DETAIL_SELECT;
}>;

/** The acting staff member. The id is the ONLY thing a write records (AC-19). */
export interface FeedbackActor {
  id: string;
}

/**
 * `ADMIN-FEEDBACK-1` — the staff triage half of the feedback domain (`SessionGuard` + `RolesGuard`).
 *
 * A second service rather than more methods on `FeedbackService`, following `AdminBookingsService`:
 * the LIFF write and the admin console share a table and nothing else, and the LIFF spec stays green
 * unmodified (AC-23).
 *
 * 🔴 PDPA, AND IT GOVERNS EVERY LOG LINE IN THIS FILE (AC-22). `subject`, `description`, `note` and
 * the reporter's phone are never logged and never interpolated into an exception message. The one
 * log line carries ids, a status and a boolean.
 *
 * There is no realtime event, no LINE notification and no post-commit side effect (plan §2 Out,
 * OQ-7): the note is internal and the list refreshes on demand.
 */
@Injectable()
export class AdminFeedbackService {
  private readonly logger = new Logger(AdminFeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /feedback` — one page, the filtered total, and the GLOBAL counts, in one round trip each.
   *
   * ⚠️ `counts` IS A `groupBy` WITH NO `where`, whatever the query says (AC-8). The prototype's
   * `paintCounts` describes the whole table; a filter that moved the pills would be indistinguishable
   * from real data changing.
   */
  async list(
    query: ListFeedbackQueryDto,
  ): Promise<PaginatedFeedbackResponseDto> {
    const where = feedbackListWhere(query);

    const [rows, total, grouped] = await Promise.all([
      this.prisma.feedback.findMany({
        where,
        select: FEEDBACK_LIST_SELECT,
        // AC-7: `code` is @unique, so the order is TOTAL — no row appears on two pages or is skipped
        // when two reports share a `createdAt`.
        orderBy: [{ createdAt: 'desc' }, { code: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.feedback.count({ where }),
      // At most 2 × 4 groups, one round trip. NO `where` — see the method note.
      this.prisma.feedback.groupBy({
        by: ['type', 'status'],
        _count: { _all: true },
      }),
    ]);

    return {
      data: rows.map(toFeedbackListItem),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
      counts: toFeedbackCounts(grouped),
    };
  }

  /** `GET /feedback/:id` — cuid only; unknown and malformed ids are both a 404 (AC-10). */
  getDetail(id: string): Promise<AdminFeedbackDetailDto> {
    return this.readDetail(this.prisma, id);
  }

  /**
   * `PATCH /feedback/:id` — the prototype's save rule (D-1), in this exact order:
   *
   *   0. No DB: neither a status nor a non-blank note → 400 `FEEDBACK_UPDATE_EMPTY` (D-1(a)).
   *   1. `SELECT … FOR UPDATE` on THIS report: the existence check, and the lock that serialises
   *      concurrent saves on it (design C-2). Without it, under READ COMMITTED a note-only save racing
   *      a status change could log `PENDING` for a row already `IN_PROGRESS`, breaking D-1(e).
   *   2. Same status and no note → 400 `FEEDBACK_NO_CHANGE` (D-1(b)), decided under the lock.
   *   3. The status is written ONLY when it changes — a note-only save leaves the row, `updatedAt`
   *      included, untouched (D-1(d)).
   *   4. Exactly one log whose status is the RESULTING status; the author is the session user (AC-19).
   *   5. The response is read inside the same transaction, so it reflects exactly this write (AC-20).
   *
   * Any state may move to any of the three accepted states — there is no transition policy (AC-21).
   */
  async update(
    id: string,
    dto: UpdateFeedbackDto,
    actor: FeedbackActor,
  ): Promise<AdminFeedbackDetailDto> {
    if (dto.status === undefined && dto.note === undefined) {
      throw new BadRequestException(FEEDBACK_UPDATE_EMPTY);
    }

    const result = await this.prisma
      .$transaction(async (tx) => {
        // Parameterised tagged template — `id` is a bound value, never spliced into the SQL.
        const locked = await tx.$queryRaw<{ status: FeedbackStatus }[]>`
          SELECT "status" FROM "feedbacks" WHERE "id" = ${id} FOR UPDATE`;
        if (locked.length === 0) {
          throw new NotFoundException(FEEDBACK_NOT_FOUND);
        }
        const current = locked[0].status;
        const next = dto.status ?? current;
        const note = dto.note ?? null;
        const changed = next !== current;

        if (!changed && note === null) {
          throw new BadRequestException(FEEDBACK_NO_CHANGE);
        }

        if (changed) {
          await tx.feedback.update({ where: { id }, data: { status: next } });
        }

        await tx.feedbackLog.create({
          data: { feedbackId: id, status: next, note, authorId: actor.id },
        });

        return {
          detail: await this.readDetail(tx, id),
          changed,
          next,
        };
      })
      // HttpExceptions pass through; a serialization failure / deadlock becomes a 409, never a 500.
      .catch(mapTransactionError);

    // Ids, the resulting status and a boolean ONLY — never the note, subject, description or phone.
    this.logger.log(
      `Feedback updated id=${id} status=${result.next} changed=${result.changed} by=${actor.id}`,
    );
    return result.detail;
  }

  /**
   * The detail read, shared by the GET and by the PATCH's echo (inside its transaction). Typed as a
   * `TransactionClient` because the root `PrismaService` is assignable to it and a tx client is not
   * assignable to `PrismaService`.
   */
  private async readDetail(
    client: Prisma.TransactionClient,
    id: string,
  ): Promise<AdminFeedbackDetailDto> {
    const row: DetailRow | null = await client.feedback.findUnique({
      where: { id },
      select: FEEDBACK_DETAIL_SELECT,
    });
    if (!row) throw new NotFoundException(FEEDBACK_NOT_FOUND);
    return {
      ...toFeedbackListItem(row),
      photos: row.photos,
      logs: row.logs.map((log) => ({
        id: log.id,
        status: log.status,
        note: log.note,
        createdAt: log.createdAt.toISOString(),
        author: log.author,
      })),
    };
  }
}

/** The list `where`: every filter ANDed; `general` means `venueId IS NULL` (AC-5). */
export function feedbackListWhere(
  query: Pick<ListFeedbackQueryDto, 'type' | 'status' | 'venueId' | 'q'>,
): Prisma.FeedbackWhereInput {
  const venue: Prisma.FeedbackWhereInput =
    query.venueId === FEEDBACK_VENUE_GENERAL
      ? { venueId: null }
      : query.venueId
        ? { venueId: query.venueId }
        : {};
  return {
    ...(query.type ? { type: query.type } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...venue,
    ...feedbackSearchWhere(query.q),
  };
}

/**
 * `q` → one `OR` over code, subject, and the reporter's two name sources (D-5).
 *
 * A local copy of `admin-bookings.service.ts`' `searchWhere` idiom, not an import — that one is typed
 * for `BookingRequest`. The term is trimmed, a leading `#` stripped, and trimmed again, so `#` alone
 * or whitespace produces NO clause at all, never `contains: ''` (E-10).
 *
 * ⚠️ `description` IS NOT SEARCHED — the placeholder does not promise it. `displayName` is searched
 * unconditionally: it is the name the card shows when no registration exists.
 */
export function feedbackSearchWhere(q?: string): Prisma.FeedbackWhereInput {
  const term = q?.trim().replace(/^#/, '').trim() ?? '';
  if (!term) return {};
  const like = { contains: term, mode: 'insensitive' } as const;
  return {
    OR: [
      { code: like },
      { subject: like },
      { lineUser: { displayName: like } },
      { lineUser: { registration: { firstName: like } } },
      { lineUser: { registration: { lastName: like } } },
    ],
  };
}

/** `groupBy(type, status)` rows → the three global numbers; a missing group counts as 0. */
export function toFeedbackCounts(
  grouped: {
    type: FeedbackType;
    status: FeedbackStatus;
    _count: { _all: number };
  }[],
): FeedbackCountsDto {
  const sum = (match: (g: (typeof grouped)[number]) => boolean) =>
    grouped.filter(match).reduce((n, g) => n + g._count._all, 0);
  return {
    pendingCount: sum((g) => g.status === FeedbackStatus.PENDING),
    issueCount: sum((g) => g.type === FeedbackType.ISSUE),
    feedbackCount: sum((g) => g.type === FeedbackType.FEEDBACK),
  };
}

/**
 * Row → list item. A missing registration yields `null` reporter fields, never a throw (D-8, AC-13);
 * the options are read without a `deletedAt` filter, so a retired department still resolves.
 */
export function toFeedbackListItem(row: ListRow): AdminFeedbackListItemDto {
  const registration = row.lineUser.registration;
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    status: row.status,
    subject: row.subject,
    description: row.description,
    photoCount: row.photos.length,
    venue: row.venue ? { id: row.venue.id, name: row.venue.name } : null,
    reporter: {
      firstName: registration?.firstName ?? null,
      lastName: registration?.lastName ?? null,
      personnelRoleName: registration?.personnelRole.name ?? null,
      departmentName: registration?.department.name ?? null,
      phone: registration?.phone ?? null,
      lineDisplayName: row.lineUser.displayName,
      pictureUrl: row.lineUser.pictureUrl ?? null,
    },
    createdAt: row.createdAt.toISOString(),
  };
}
