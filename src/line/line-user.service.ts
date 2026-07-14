import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AppAccess, LineUser, RichMenuType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LineUserResponseDto } from './dto/line-user-response.dto';
import { ListLineUsersQueryDto } from './dto/list-line-users-query.dto';
import { PaginatedLineUsersResponseDto } from './dto/paginated-line-users-response.dto';
import { LineService } from './line.service';
import { LINE_USER_NOT_FOUND } from './line-users.errors';
import { RICH_MENU_SPECS } from './rich-menu.constants';

/** Profile fields captured when a user follows the OA (all best-effort). */
export interface LineProfileInput {
  lineUserId: string;
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
  language?: string | null;
}

/**
 * THE one definition of "a publicly visible LineUser" — exactly the `LineUserResponseDto` fields.
 * Kept explicit so the DTO stays the response boundary (never `deletedAt`/`language`/audit columns),
 * mirroring `system-users.fields.ts`'s `PUBLIC_FIELDS`.
 */
export const LINE_USER_PUBLIC_FIELDS = {
  id: true,
  lineUserId: true,
  displayName: true,
  pictureUrl: true,
  statusMessage: true,
  richMenuType: true,
  access: true,
  followedAt: true,
} as const;

/** A `LineUser` row narrowed to `LINE_USER_PUBLIC_FIELDS`. `followedAt` is still a `Date`. */
export type PublicLineUser = Prisma.LineUserGetPayload<{
  select: typeof LINE_USER_PUBLIC_FIELDS;
}>;

@Injectable()
export class LineUserService {
  private readonly logger = new Logger(LineUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
  ) {}

  /**
   * Create the user on first follow, or restore (clear deletedAt) + refresh the
   * profile on re-follow. Existing `access`/`richMenuType` are preserved.
   */
  upsertOnFollow(profile: LineProfileInput): Promise<LineUser> {
    const { lineUserId, ...rest } = profile;
    const data = {
      displayName: rest.displayName ?? null,
      pictureUrl: rest.pictureUrl ?? null,
      statusMessage: rest.statusMessage ?? null,
      language: rest.language ?? null,
    };
    return this.prisma.lineUser.upsert({
      where: { lineUserId },
      create: { lineUserId, ...data },
      update: { ...data, deletedAt: null, followedAt: new Date() },
    });
  }

  /** Soft-delete on unfollow (no error if already absent/deleted). */
  softDeleteByLineUserId(lineUserId: string): Promise<{ count: number }> {
    return this.prisma.lineUser.updateMany({
      where: { lineUserId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  /** Look up an active (non-soft-deleted) user. */
  findActiveByLineUserId(lineUserId: string): Promise<LineUser | null> {
    return this.prisma.lineUser.findFirst({
      where: { lineUserId, deletedAt: null },
    });
  }

  /** Set the user's rich-menu type in the DB. Returns null if no active user. */
  async setRichMenuType(
    lineUserId: string,
    richMenuType: RichMenuType,
  ): Promise<LineUser | null> {
    const user = await this.findActiveByLineUserId(lineUserId);
    if (!user) return null;
    return this.prisma.lineUser.update({
      where: { id: user.id },
      data: { richMenuType },
    });
  }

  /**
   * Apply the user's current richMenuType on LINE by resolving the menu id from
   * its name and linking it to the user. Throws if the menu isn't on LINE yet.
   */
  async applyRichMenu(user: LineUser): Promise<void> {
    const spec = RICH_MENU_SPECS[user.richMenuType];
    const richMenuId = await this.line.findRichMenuId(spec);
    if (!richMenuId) {
      throw new Error(
        `Rich menu '${spec.name}' (${spec.width}x${spec.height}) not found on LINE — run 'npm run line:setup-richmenu' first.`,
      );
    }
    await this.line.linkRichMenuToUser(user.lineUserId, richMenuId);
  }

  /**
   * Paginated, filtered, searched list of active (non-soft-deleted) LINE users for the back-office
   * dashboard. Models `SystemUsersService.findManyPaginated`.
   *
   * `RepeatableRead`, not the default: under READ COMMITTED each statement takes a fresh snapshot,
   * so `meta.total` could genuinely disagree with `data`. A read-only RepeatableRead transaction can
   * never abort.
   */
  async findManyPaginated({
    page,
    limit,
    search,
    access,
  }: ListLineUsersQueryDto): Promise<PaginatedLineUsersResponseDto> {
    const trimmed = search?.trim();
    const where: Prisma.LineUserWhereInput = {
      deletedAt: null, // AC-B6 — soft-deleted rows never appear, in data or in total.
      ...(access ? { access } : {}),
      ...(trimmed
        ? { displayName: { contains: trimmed, mode: 'insensitive' } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.lineUser.findMany({
          where,
          select: LINE_USER_PUBLIC_FIELDS,
          // The `id` tiebreak is MANDATORY — `followedAt` is not unique, and without it rows can
          // repeat or vanish across pages.
          orderBy: [{ followedAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.lineUser.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      data: rows.map((row) => this.toDto(row)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Approve/block a LINE user by writing `access`. Keyed on the cuid `LineUser.id`.
   *
   * A guarded read-then-write: `findFirst({ id, deletedAt: null })` first, so an unknown id and a
   * soft-deleted id both raise a byte-identical `404` (AC-B10). No transaction/isolation ceremony —
   * `LineUser.access` has no last-active-invariant and no unique-collision surface, so two
   * concurrent PATCHes are last-writer-wins on one field, which is acceptable at this scale.
   */
  async updateAccess(
    id: string,
    access: AppAccess,
  ): Promise<LineUserResponseDto> {
    const existing = await this.prisma.lineUser.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(LINE_USER_NOT_FOUND);

    const updated = await this.prisma.lineUser.update({
      where: { id: existing.id },
      data: { access },
      select: LINE_USER_PUBLIC_FIELDS,
    });
    // PII discipline: log the id only, never the full LineUser object.
    this.logger.log(
      `LineUser access changed. id=${updated.id} access=${access}`,
    );
    return this.toDto(updated);
  }

  toDto(user: PublicLineUser): LineUserResponseDto {
    return {
      id: user.id,
      lineUserId: user.lineUserId,
      displayName: user.displayName,
      pictureUrl: user.pictureUrl,
      statusMessage: user.statusMessage,
      richMenuType: user.richMenuType,
      access: user.access,
      followedAt: user.followedAt.toISOString(),
    };
  }
}
