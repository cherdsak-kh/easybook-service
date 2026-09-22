import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mapTransactionError } from '../common/prisma-tx.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CANNED_REPLIES_LIMIT_EXCEEDED,
  CANNED_REPLIES_LOCK_NS,
  CANNED_REPLIES_MAX,
  CANNED_REPLY_NOT_FOUND,
  CANNED_REPLY_SORT_ORDER_MAX,
  CANNED_REPLY_UPDATE_EMPTY,
} from './canned-replies.constants';
import type { CannedReplyErrorCode } from './dto/canned-reply-error.dto';
import type { CannedReplyDto } from './dto/canned-reply-response.dto';
import type {
  CreateCannedReplyDto,
  UpdateCannedReplyDto,
} from './dto/canned-reply-write.dto';

/** What every response renders. */
export const CANNED_REPLY_SELECT = {
  id: true,
  title: true,
  text: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CannedReplySelect;

/** D-5 — `sortOrder ASC`, ties → `createdAt ASC` → `id ASC`: a total, deterministic order. */
export const CANNED_REPLY_ORDER: Prisma.CannedReplyOrderByWithRelationInput[] =
  [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

type CannedReplyRow = Prisma.CannedReplyGetPayload<{
  select: typeof CANNED_REPLY_SELECT;
}>;

/** A Nest exception class whose first argument becomes the response body when it is an object. */
type HttpExceptionClass = new (objectOrError?: unknown) => HttpException;

/**
 * The house `{ statusCode, error, message }` plus `code` — the same body the announcements module
 * builds (copied, not imported across modules). The house fields come from Nest itself, so the shape
 * cannot drift from every other error body.
 */
function codedError(
  Exception: HttpExceptionClass,
  code: CannedReplyErrorCode,
  message: string,
): HttpException {
  const base = new Exception(message).getResponse() as Record<string, unknown>;
  return new Exception({ ...base, code });
}

const notFound = () =>
  codedError(
    NotFoundException,
    'CANNED_REPLY_NOT_FOUND',
    CANNED_REPLY_NOT_FOUND,
  );

/**
 * `ข้อความตอบกลับด่วน` — CRUD over `CannedReply` (ANNOUNCE-API-5, D-3…D-5). HARD delete; at most
 * {@link CANNED_REPLIES_MAX} rows, enforced by `create` under an advisory lock.
 *
 * Log lines carry ids only. A canned reply is staff-authored, not personal data, but the house
 * habit holds.
 */
@Injectable()
export class CannedRepliesService {
  private readonly logger = new Logger(CannedRepliesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `GET /canned-replies` — every row, in the D-5 order. An empty table is `[]`. */
  async list(): Promise<CannedReplyDto[]> {
    const rows = await this.prisma.cannedReply.findMany({
      select: CANNED_REPLY_SELECT,
      orderBy: CANNED_REPLY_ORDER,
    });
    return rows.map(toCannedReplyDto);
  }

  /**
   * `POST /canned-replies` — D-3: ONE interactive transaction whose FIRST statement takes the
   * table-wide advisory lock, so two concurrent POSTs at 4 rows serialise and the second sees 5.
   * The lock is released at commit or rollback.
   *
   * ⚠️ `$executeRaw`, NOT `$queryRaw`: `pg_advisory_xact_lock` returns `void`, which Prisma 7's
   * `$queryRaw` cannot deserialize (see `lockVenue` in `admin-bookings.service.ts`). Both
   * placeholders are cast `::int4`, or Postgres cannot resolve the overload.
   */
  async create(
    dto: CreateCannedReplyDto,
    actorId: string,
  ): Promise<CannedReplyDto> {
    const row = await this.prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CANNED_REPLIES_LOCK_NS}::int4, ${0}::int4)`;

        const count = await tx.cannedReply.count();
        if (count >= CANNED_REPLIES_MAX) {
          throw codedError(
            BadRequestException,
            'CANNED_REPLIES_LIMIT_EXCEEDED',
            CANNED_REPLIES_LIMIT_EXCEEDED,
          );
        }

        let sortOrder = dto.sortOrder;
        if (sortOrder === undefined) {
          // Bottom of the list; clamped so the server never writes a value its own DTO rejects (S-4).
          const { _max } = await tx.cannedReply.aggregate({
            _max: { sortOrder: true },
          });
          sortOrder =
            _max.sortOrder === null
              ? 0
              : Math.min(_max.sortOrder + 1, CANNED_REPLY_SORT_ORDER_MAX);
        }

        return tx.cannedReply.create({
          data: { title: dto.title, text: dto.text, sortOrder },
          select: CANNED_REPLY_SELECT,
        });
      })
      .catch(mapTransactionError);

    this.logger.log(`Canned reply created id=${row.id} by=${actorId}`);
    return toCannedReplyDto(row);
  }

  /**
   * `PATCH /canned-replies/:id` — no lock and no count (D-3: an edit cannot change the row count).
   * A guarded `updateMany` (design S-7): `count 0` → 404. `@updatedAt` advances.
   */
  async update(
    id: string,
    dto: UpdateCannedReplyDto,
    actorId: string,
  ): Promise<CannedReplyDto> {
    if (
      dto.title === undefined &&
      dto.text === undefined &&
      dto.sortOrder === undefined
    ) {
      throw codedError(
        BadRequestException,
        'CANNED_REPLY_UPDATE_EMPTY',
        CANNED_REPLY_UPDATE_EMPTY,
      );
    }

    const { count } = await this.prisma.cannedReply.updateMany({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.text !== undefined ? { text: dto.text } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
    if (count === 0) throw notFound();

    // A row deleted between the write and this read is a 404 too.
    const row = await this.prisma.cannedReply.findUnique({
      where: { id },
      select: CANNED_REPLY_SELECT,
    });
    if (!row) throw notFound();

    this.logger.log(`Canned reply updated id=${id} by=${actorId}`);
    return toCannedReplyDto(row);
  }

  /** `DELETE /canned-replies/:id` — a HARD delete (the PO's model has no `deletedAt`). */
  async remove(id: string, actorId: string): Promise<void> {
    const { count } = await this.prisma.cannedReply.deleteMany({
      where: { id },
    });
    if (count === 0) throw notFound();

    this.logger.log(`Canned reply deleted id=${id} by=${actorId}`);
  }
}

/** Row → wire shape: ISO timestamps. */
export function toCannedReplyDto(row: CannedReplyRow): CannedReplyDto {
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
