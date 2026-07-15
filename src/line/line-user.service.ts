import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AppAccess,
  LineUser,
  LineUserRegistration,
  RichMenuType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { LineUserRegistrationResponseDto } from './dto/line-user-registration-response.dto';
import { LineUserResponseDto } from './dto/line-user-response.dto';
import { LineUserStatusResponseDto } from './dto/line-user-status-response.dto';
import { ListLineUsersQueryDto } from './dto/list-line-users-query.dto';
import { PaginatedLineUsersResponseDto } from './dto/paginated-line-users-response.dto';
import { LineService } from './line.service';
import {
  ALREADY_REGISTERED,
  LINE_RICH_MENU_APPLY_FAILED,
  LINE_USER_NOT_FOUND,
  STUDENT_STAFF_ID_TAKEN,
} from './line-users.errors';
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
 * Derives the rich menu from `access` (design §4): only ALLOWED users get the booking menu.
 * ALLOWED → TYPE_2; UNREGISTERED / PENDING / BLOCKED → TYPE_1.
 */
export const accessToRichMenuType = (access: AppAccess): RichMenuType =>
  access === 'ALLOWED' ? 'TYPE_2' : 'TYPE_1';

/**
 * The best-effort LINE push copy sent to a user after a successful status change.
 * A `null` value means "send nothing" — `UNREGISTERED` (and any state not worth notifying on)
 * maps to `null`. This is the single source of truth for the PENDING message so `register`'s
 * push and `updateAccess`'s PENDING push can never drift apart.
 */
export const ACCESS_NOTIFICATION_MESSAGES: Record<AppAccess, string | null> = {
  UNREGISTERED: null,
  PENDING:
    'ระบบได้รับข้อมูลการลงทะเบียนของคุณแล้ว เจ้าหน้าที่กำลังดำเนินการตรวจสอบข้อมูลกรุณารอสักครู่ครับ ⏳',
  ALLOWED:
    'ยินดีด้วย! บัญชีของคุณได้รับการอนุมัติการใช้งานเรียบร้อยแล้ว คุณสามารถกดปุ่มจองคิวที่เมนูด้านล่างเพื่อทำรายการได้ทันทีครับ 🎉',
  BLOCKED:
    'ขออภัย บัญชีการใช้งานของคุณถูกระงับสิทธิ์ชั่วคราวโดยผู้ดูแลระบบ หากมีข้อสงสัยกรุณาติดต่อเจ้าหน้าที่สถาบัน',
};

/**
 * THE one definition of "a publicly visible LineUser" — exactly the `LineUserResponseDto` fields.
 * Kept explicit so the DTO stays the response boundary (never `deletedAt`/`language`/audit columns),
 * mirroring `system-users.fields.ts`'s `PUBLIC_FIELDS`. The nested `registration` select is the
 * compact admin summary — it now includes `phone` so admins can vet an applicant (a deliberate
 * reversal of the earlier PII-minimisation decision, at the product owner's request).
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
  registration: {
    select: {
      firstName: true,
      lastName: true,
      studentStaffId: true,
      phone: true,
      department: true,
      role: true,
    },
  },
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

  /**
   * Get the active `LineUser` for a verified LINE `sub`, creating a fresh `UNREGISTERED` row if
   * none exists. Robust whether the user followed the OA first (webhook created the row) or opened
   * the LIFF first (no webhook fires on LIFF open). Deliberately NOT `upsertOnFollow` — that resets
   * `followedAt`/`deletedAt`, which are follow-lifecycle concerns, not registration concerns.
   */
  async getOrCreateByLineUserId(lineUserId: string): Promise<LineUser> {
    const existing = await this.findActiveByLineUserId(lineUserId);
    if (existing) return existing;
    return this.prisma.lineUser.create({ data: { lineUserId } });
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
   * Apply the user's current richMenuType on LINE by resolving the menu id from its name and
   * linking it to the user. Throws if the menu isn't on LINE yet. Reads only `lineUserId` +
   * `richMenuType`, so it accepts any narrowed payload carrying those two fields.
   */
  async applyRichMenu(user: {
    lineUserId: string;
    richMenuType: RichMenuType;
  }): Promise<void> {
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
   * Best-effort LINE push of the copy mapped to `access` (design §4). NEVER throws: a push failure
   * (e.g. the user has blocked the OA) must not roll back the already-persisted status change or turn
   * a successful request into a 5xx — it is logged at `warn` and swallowed. `UNREGISTERED`/unmapped
   * access values send nothing. The `await` is caught, so there is no floating promise.
   *
   * @param lineUserId the LINE-side `U…` identifier (`LineUser.lineUserId`), NOT the cuid `LineUser.id`.
   */
  private async notifyAccessChange(
    lineUserId: string,
    access: AppAccess,
  ): Promise<void> {
    const text = ACCESS_NOTIFICATION_MESSAGES[access];
    if (!text) return;
    try {
      await this.line.push(lineUserId, [{ type: 'text', text }]);
    } catch (error) {
      // Best-effort: log the LINE id + target access (never PII) and continue.
      this.logger.warn(
        `Best-effort push notification failed (status change already persisted). lineUserId=${lineUserId} access=${access}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Register the caller (identified by their verified LINE `sub`) and transition
   * `UNREGISTERED → PENDING`. The rich menu stays `TYPE_1` (untouched).
   *
   * One `$transaction`: get-or-create the active LineUser, gate on `UNREGISTERED`, create the 1:1
   * registration, then flip `access` to `PENDING`. A `P2002` on the LineUser 1:1 (a race) or on
   * `studentStaffId` (used by someone else) becomes a `409` with distinct messages (design §3.1).
   */
  async register(
    lineUserId: string,
    dto: CreateLineUserRegistrationDto,
  ): Promise<LineUserStatusResponseDto> {
    try {
      const { userId, access, registration } = await this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.lineUser.findFirst({
            where: { lineUserId, deletedAt: null },
            select: { id: true, access: true },
          });
          const user =
            existing ??
            (await tx.lineUser.create({
              data: { lineUserId },
              select: { id: true, access: true },
            }));

          // State gate (AC-B5): only an UNREGISTERED user may register. Any other state already
          // has a registration — a deterministic 409, never a silent duplicate.
          if (user.access !== 'UNREGISTERED') {
            throw new ConflictException(ALREADY_REGISTERED);
          }

          const created = await tx.lineUserRegistration.create({
            data: {
              lineUserId: user.id,
              firstName: dto.firstName,
              lastName: dto.lastName,
              studentStaffId: dto.studentStaffId,
              phone: dto.phone,
              department: dto.department,
              role: dto.role,
            },
          });

          const updated = await tx.lineUser.update({
            where: { id: user.id },
            data: { access: 'PENDING' },
            select: { access: true },
          });

          return {
            userId: user.id,
            access: updated.access,
            registration: created,
          };
        },
      );

      // PII discipline: log the id only, never the submitted PII.
      this.logger.log(`LineUser registered. id=${userId} access=${access}`);

      // Best-effort "we received your registration" push (PENDING copy). Outside the transaction
      // so a push failure can never roll back the committed registration/access change.
      await this.notifyAccessChange(lineUserId, access);

      return this.toStatusDto(access, registration);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const rawTarget = error.meta?.target;
        const target = Array.isArray(rawTarget)
          ? rawTarget.join(',')
          : typeof rawTarget === 'string'
            ? rawTarget
            : '';
        throw new ConflictException(
          target.includes('studentStaffId')
            ? STUDENT_STAFF_ID_TAKEN
            : ALREADY_REGISTERED,
        );
      }
      throw error;
    }
  }

  /**
   * The caller's own status view (design §3.2). Header-derived, param-less: identity is the verified
   * `sub`, so a caller can only ever read their own status. A LIFF-first user with no prior row gets
   * a fresh `UNREGISTERED` row + `registration: null`.
   */
  async getStatus(lineUserId: string): Promise<LineUserStatusResponseDto> {
    const user = await this.getOrCreateByLineUserId(lineUserId);
    const registration = await this.prisma.lineUserRegistration.findFirst({
      where: { lineUserId: user.id, deletedAt: null },
    });
    return this.toStatusDto(user.access, registration);
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
   * Approve/block a LINE user by writing `access` AND the derived `richMenuType`, then applying the
   * menu on LINE. Keyed on the cuid `LineUser.id`.
   *
   * DB-first (design §4): the row is the source of truth, so it is written before the LINE call.
   * If `applyRichMenu` fails, the DB is already correct and the error surfaces as a retryable `502`
   * — a re-approve/re-block re-writes the same state and re-applies the menu, which is idempotent on
   * LINE (linking an already-linked menu is a no-op). A guarded read (`findFirst({ id, deletedAt:
   * null })`) keeps an unknown or soft-deleted id a byte-identical `404`.
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

    const richMenuType = accessToRichMenuType(access);
    const updated = await this.prisma.lineUser.update({
      where: { id: existing.id },
      data: { access, richMenuType },
      select: LINE_USER_PUBLIC_FIELDS,
    });

    try {
      await this.applyRichMenu({
        lineUserId: updated.lineUserId,
        richMenuType: updated.richMenuType,
      });
    } catch (error) {
      // PII discipline: id + derived menu only, never the object.
      this.logger.error(
        `Rich-menu apply failed (DB already updated). id=${updated.id} richMenuType=${richMenuType}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new BadGatewayException(LINE_RICH_MENU_APPLY_FAILED);
    }

    this.logger.log(
      `LineUser access changed. id=${updated.id} access=${access} richMenuType=${richMenuType}`,
    );

    // Best-effort notification, only after BOTH the DB write and the rich-menu apply succeeded.
    // Pushed to the LINE-side U… id (updated.lineUserId), never the cuid. A push failure here does
    // not undo the access change or the linked menu, and must not fail the request.
    await this.notifyAccessChange(updated.lineUserId, access);

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
      registration: user.registration
        ? {
            firstName: user.registration.firstName,
            lastName: user.registration.lastName,
            studentStaffId: user.registration.studentStaffId,
            phone: user.registration.phone,
            department: user.registration.department,
            role: user.registration.role,
          }
        : null,
    };
  }

  private toStatusDto(
    access: AppAccess,
    registration: LineUserRegistration | null,
  ): LineUserStatusResponseDto {
    return {
      access,
      registration: registration
        ? this.toRegistrationResponseDto(registration)
        : null,
    };
  }

  private toRegistrationResponseDto(
    registration: LineUserRegistration,
  ): LineUserRegistrationResponseDto {
    return {
      id: registration.id,
      firstName: registration.firstName,
      lastName: registration.lastName,
      studentStaffId: registration.studentStaffId,
      phone: registration.phone,
      department: registration.department,
      role: registration.role,
      createdAt: registration.createdAt.toISOString(),
      updatedAt: registration.updatedAt.toISOString(),
    };
  }
}
