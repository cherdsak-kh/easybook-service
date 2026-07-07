import { Injectable } from '@nestjs/common';
import type { LineUser, RichMenuType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LineUserResponseDto } from './dto/line-user-response.dto';
import { LineService } from './line.service';
import { RICH_MENU_SPECS } from './rich-menu.constants';

/** Profile fields captured when a user follows the OA (all best-effort). */
export interface LineProfileInput {
  lineUserId: string;
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
  language?: string | null;
}

@Injectable()
export class LineUserService {
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

  toDto(user: LineUser): LineUserResponseDto {
    return {
      lineUserId: user.lineUserId,
      displayName: user.displayName,
      pictureUrl: user.pictureUrl,
      richMenuType: user.richMenuType,
      access: user.access,
      followedAt: user.followedAt.toISOString(),
    };
  }
}
