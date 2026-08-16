import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppAccess, Prisma, SystemRole } from '@prisma/client';
import type { LineUser, RichMenuType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { canAdminSetAccess } from './line-access.policy';
import { AdminUpdateLineUserRegistrationDto } from './dto/admin-update-line-user-registration.dto';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { LineUserRegistrationResponseDto } from './dto/line-user-registration-response.dto';
import { LineUserResponseDto } from './dto/line-user-response.dto';
import { LineUserStatusResponseDto } from './dto/line-user-status-response.dto';
import { ListLineUsersQueryDto } from './dto/list-line-users-query.dto';
import { PaginatedLineUsersResponseDto } from './dto/paginated-line-users-response.dto';
import { RegistrationOptionsResponseDto } from './dto/registration-options-response.dto';
import { UpdateLineUserRegistrationDto } from './dto/update-line-user-registration.dto';
import { LineService } from './line.service';
import {
  ALREADY_REGISTERED,
  CANNOT_REJECT_UNREGISTERED,
  INVALID_DEPARTMENT,
  INVALID_PERSONNEL_ROLE,
  LINE_RICH_MENU_APPLY_FAILED,
  LINE_USER_ACCESS_TRANSITION_FORBIDDEN,
  LINE_USER_NOT_FOUND,
  LINE_USER_REGISTRATION_NOT_FOUND,
  REGISTRATION_NOT_EDITABLE,
  REJECTION_REASON_REQUIRED,
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
    'ระบบได้รับข้อมูลการลงทะเบียนของคุณแล้ว เจ้าหน้าที่กำลังดำเนินการตรวจสอบข้อมูล กรุณารอสักครู่ ⏳',
  ALLOWED:
    'ยินดีด้วย! บัญชีของคุณได้รับการอนุมัติการใช้งานเรียบร้อยแล้ว คุณสามารถกดที่เมนูด้านล่างเพื่อใช้งานระบบได้ทันที 🎉',
  BLOCKED:
    'ขออภัย บัญชีการใช้งานของคุณถูกระงับสิทธิ์ชั่วคราว หากมีข้อสงสัยกรุณาติดต่อเจ้าหน้าที่',
  // The reject copy is built by `buildRejectionMessage` below (it interpolates the mandatory
  // reason), NOT here — so this entry is `null` ("notifyAccessChange sends nothing for REJECTED").
  // Keeping the reject copy out of this record is deliberate: this record is register()'s single
  // source for the PENDING ack and must not be overwritten or repurposed.
  REJECTED: null,
};

/**
 * THE one definition of the Reject push copy. It cannot live in `ACCESS_NOTIFICATION_MESSAGES`
 * (a static `Record`) because it interpolates the mandatory rejection reason — hence a builder,
 * kept adjacent to that record so both copy sources sit together.
 */
export const buildRejectionMessage = (reason: string): string =>
  `ขออภัย การลงทะเบียนของคุณไม่ผ่านการอนุมัติ เนื่องจาก: ${reason} กรุณาเปิดแอปพลิเคชันเพื่อแก้ไขข้อมูลใหม่อีกครั้ง`;

/** Where a phone number stops being a phone number and starts being an extension. */
const EXTENSION_MARKER = /\s*(?:ต่อ|ext\.?|#)\s*/i;

/**
 * `LineUserRegistration.phone` -> `phoneDigits`. THE only writer of that column: call it wherever
 * `phone` is written, in the same `data` object, so the two can never drift apart.
 *
 * Two rules, both of which exist because an operator typing into the registration search box is
 * reading a number off a form and not off the screen:
 *   1. Every non-digit is dropped, so "081-234-5678" and "0812345678" are the same query.
 *   2. Anything after an extension marker is dropped ENTIRELY rather than concatenated.
 *      "02-123-4567 ต่อ 101" is `021234567`; keeping the extension would make it `021234567101`,
 *      and then searching "101" returns every number whose extension is 101 — which is never what
 *      someone searching a phone number meant.
 *
 * ⚠️ A leading "+66" normalises to "66…", so an international-format row will not match a query
 * typed in local "08…" form. Left alone deliberately: the registration form is filled in by Thai
 * staff in local format, and a rewrite rule that guesses country codes fails in a much quieter way.
 */
export const toPhoneDigits = (phone: string): string =>
  phone.split(EXTENSION_MARKER)[0].replace(/\D/g, '');

/**
 * THE one definition of "a publicly visible LineUser" — exactly the `LineUserResponseDto` fields.
 * Kept explicit so the DTO stays the response boundary (never `deletedAt`/`language`/audit columns),
 * mirroring `system-users.fields.ts`'s `PUBLIC_FIELDS`. The nested `registration` select is the
 * compact admin summary: the name + `phone` + the RESOLVED option names (via the FK relations, with
 * NO `deletedAt` filter — a soft-deleted option must still resolve its name for display, SC-2.4).
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
      phone: true,
      departmentId: true,
      personnelRoleId: true,
      department: { select: { name: true } },
      personnelRole: { select: { name: true } },
    },
  },
} as const;

/** A `LineUser` row narrowed to `LINE_USER_PUBLIC_FIELDS`. `followedAt` is still a `Date`. */
export type PublicLineUser = Prisma.LineUserGetPayload<{
  select: typeof LINE_USER_PUBLIC_FIELDS;
}>;

/**
 * The owner-facing registration select: identity/contact fields plus BOTH option ids (so the Pending
 * edit form can pre-select) and the resolved option names (for display). No `deletedAt` filter on the
 * relation selects — the name resolves even when the referenced option was later soft-deleted.
 */
const REGISTRATION_OWNER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  departmentId: true,
  personnelRoleId: true,
  department: { select: { name: true } },
  personnelRole: { select: { name: true } },
  createdAt: true,
  updatedAt: true,
} as const;

/** A `LineUserRegistration` narrowed to `REGISTRATION_OWNER_SELECT`. */
type OwnerRegistration = Prisma.LineUserRegistrationGetPayload<{
  select: typeof REGISTRATION_OWNER_SELECT;
}>;

@Injectable()
export class LineUserService {
  private readonly logger = new Logger(LineUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly line: LineService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Fail-soft realtime publish. NEVER throws — it mirrors `notifyAccessChange`'s discipline: the
   * write has already committed, so a fan-out failure is logged at `warn` and swallowed and can
   * never roll back or fail the mutation.
   *
   * The `deletedAt: null` filter is **LOAD-BEARING, not defensive**: it is what structurally
   * guarantees a soft-deleted row can never reach a `created`/`updated` event, for every call site
   * at once — including the SUPER_ADMIN-only soft-deleted reach in `updateAccess` /
   * `updateRegistrationByAdmin`, which would otherwise inject a row into every admin's table that
   * `GET /line-users` refuses to return.
   *
   * The extra primary-key read is a deliberate trade: `updateAccess` and `updateRegistrationByAdmin`
   * already hold a `PublicLineUser`, but using the row in hand there and re-reading elsewhere would
   * mean two payload construction rules and two places for the soft-delete guard to be forgotten.
   * **Do not "optimise" this away** without re-establishing that guarantee at every call site.
   */
  private async publish(
    kind: 'created' | 'updated',
    id: string,
  ): Promise<void> {
    try {
      const row = await this.prisma.lineUser.findFirst({
        where: { id, deletedAt: null },
        select: LINE_USER_PUBLIC_FIELDS,
      });
      // Soft-deleted or gone → no event, by design.
      if (!row) return;
      const dto = this.toDto(row);
      if (kind === 'created') this.realtime.emitLineUserCreated(dto);
      else this.realtime.emitLineUserUpdated(dto);
    } catch (error) {
      // PII discipline: id + kind only. Never the DTO, never a name or phone.
      this.logger.warn(
        `Realtime publish failed (write already committed). id=${id} kind=${kind}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Create the user on first follow, or restore (clear deletedAt) + refresh the
   * profile on re-follow. Existing `access`/`richMenuType` are preserved.
   */
  async upsertOnFollow(profile: LineProfileInput): Promise<LineUser> {
    const { lineUserId, ...rest } = profile;
    const data = {
      displayName: rest.displayName ?? null,
      pictureUrl: rest.pictureUrl ?? null,
      statusMessage: rest.statusMessage ?? null,
      language: rest.language ?? null,
    };
    const user = await this.prisma.lineUser.upsert({
      where: { lineUserId },
      create: { lineUserId, ...data },
      update: { ...data, deletedAt: null, followedAt: new Date() },
    });

    // Emit site 1. A re-follow after an unfollow re-surfaces the row, so `created` is correct; the
    // client's `created` handler is an upsert, so a plain profile refresh is harmless.
    // `LineWebhookService` stays unchanged — the emit belongs to the service that owns the model.
    await this.publish('created', user.id);
    return user;
  }

  /**
   * Soft-delete on unfollow (no error if already absent/deleted).
   *
   * The id lookup exists because `updateMany` returns only a count and `lineUser.deleted` needs the
   * cuid. `lineUserId` is `@unique`, so this is an indexed read and no new index is required. The
   * `{ count }` return type is UNCHANGED, so `LineWebhookService` needs no edit. A concurrent double
   * unfollow can emit `deleted` twice; the client's remove-by-id is idempotent.
   */
  async softDeleteByLineUserId(lineUserId: string): Promise<{ count: number }> {
    const row = await this.prisma.lineUser.findFirst({
      where: { lineUserId, deletedAt: null },
      select: { id: true },
    });
    if (!row) return { count: 0 };

    await this.prisma.lineUser.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });

    // Emit site 6. "Deleted" means "left the list you are looking at" — the physical row survives.
    this.realtime.emitLineUserDeleted(row.id);
    return { count: 1 };
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
   * Best-effort LINE push for a Reject (→REJECTED). NEVER throws (same fail-soft discipline as
   * `notifyAccessChange`): a push failure is logged at `warn` and swallowed — the reject write already
   * committed. The reject copy comes from `buildRejectionMessage`, deliberately NOT added to
   * `ACCESS_NOTIFICATION_MESSAGES`: that record is `register()`'s single source for the PENDING ack and
   * must not be overwritten or the ack regresses. `reason` is always present (mandatory, guarded in
   * `updateAccess`).
   * PII: the reason is NEVER logged (log lines stay lineUserId=/access= only, matching notifyAccessChange).
   *
   * @param lineUserId the LINE-side `U…` identifier (`LineUser.lineUserId`), NOT the cuid `LineUser.id`.
   */
  private async notifyRejection(
    lineUserId: string,
    reason: string,
  ): Promise<void> {
    const text = buildRejectionMessage(reason);
    try {
      await this.line.push(lineUserId, [{ type: 'text', text }]);
    } catch (error) {
      // PII discipline: never log the reason — only the LINE id + target access.
      this.logger.warn(
        `Best-effort reject push failed (status change already persisted). lineUserId=${lineUserId} access=REJECTED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * The combined, non-deleted option lists for the registration form (SC-3.1). One read per table,
   * each `name ASC`. Ids + names only — no PII, no timestamps.
   *
   * `isSystemReserved: false` is HARDCODED, with no parameter to widen it. This surface has no actor
   * and no `SystemRole` to branch on — the identity is a verified LINE `sub`, and `SystemUser` /
   * `LineUser` share no session and no authentication surface. So no role check belongs here, and a
   * LINE caller can never see a reserved option under any circumstance.
   */
  async getRegistrationOptions(): Promise<RegistrationOptionsResponseDto> {
    const [departments, personnelRoles] = await Promise.all([
      this.prisma.department.findMany({
        where: { deletedAt: null, isSystemReserved: false },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.personnelRole.findMany({
        where: { deletedAt: null, isSystemReserved: false },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { departments, personnelRoles };
  }

  /**
   * Assert both chosen option ids resolve to a NON-DELETED, NON-RESERVED option (SC-3.2/SC-B6). A
   * soft-deleted, unknown or system-reserved id is a client-side validation failure → `400` (distinct
   * message per field), never a `409`. The FK's `onDelete: Restrict` does not help here — a
   * soft-deleted option row still exists, so the DB would accept the FK; this app-level check is what
   * rejects it.
   *
   * `isSystemReserved: false` is HARDCODED and unconditional: no LINE caller has a `SystemRole`, so
   * NOBODY may assign a reserved option through this surface. The predicate merges into the SAME
   * query as `deletedAt: null` — one more attribute of "may this id be referenced", not a second
   * round trip — and yields the SAME 400 as an unknown id. Never a 403: a distinct status would be an
   * existence oracle and would defeat the invisibility the reserved flag exists for.
   */
  private async assertActiveOptions(
    client: Pick<Prisma.TransactionClient, 'department' | 'personnelRole'>,
    departmentId: number,
    personnelRoleId: number,
  ): Promise<void> {
    const [department, personnelRole] = await Promise.all([
      client.department.findFirst({
        where: { id: departmentId, deletedAt: null, isSystemReserved: false },
        select: { id: true },
      }),
      client.personnelRole.findFirst({
        where: {
          id: personnelRoleId,
          deletedAt: null,
          isSystemReserved: false,
        },
        select: { id: true },
      }),
    ]);
    if (!department) throw new BadRequestException(INVALID_DEPARTMENT);
    if (!personnelRole) throw new BadRequestException(INVALID_PERSONNEL_ROLE);
  }

  /**
   * Register the caller (identified by their verified LINE `sub`) and transition
   * `UNREGISTERED → PENDING`. The rich menu stays `TYPE_1` (untouched).
   *
   * One `$transaction`: get-or-create the active LineUser, gate on `UNREGISTERED`, assert both option
   * ids are non-deleted (`400`), create the 1:1 registration, then flip `access` to `PENDING`. A
   * `P2002` on the LineUser 1:1 (a race) becomes a `409 ALREADY_REGISTERED` (design §3.1).
   */
  async register(
    lineUserId: string,
    dto: CreateLineUserRegistrationDto,
  ): Promise<LineUserStatusResponseDto> {
    try {
      const { userId, access, registration, wasCreated } =
        await this.prisma.$transaction(async (tx) => {
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

          await this.assertActiveOptions(
            tx,
            dto.departmentId,
            dto.personnelRoleId,
          );

          const created = await tx.lineUserRegistration.create({
            data: {
              lineUserId: user.id,
              firstName: dto.firstName,
              lastName: dto.lastName,
              phone: dto.phone,
              phoneDigits: toPhoneDigits(dto.phone),
              departmentId: dto.departmentId,
              personnelRoleId: dto.personnelRoleId,
            },
            select: REGISTRATION_OWNER_SELECT,
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
            // The transaction already knows whether it created the row, so the created-vs-updated
            // decision costs zero extra reads.
            wasCreated: existing === null,
          };
        });

      // PII discipline: log the id only, never the submitted PII.
      this.logger.log(`LineUser registered. id=${userId} access=${access}`);

      // Emit site 2 — after the commit, BEFORE the LINE push (a best-effort HTTP call that can take
      // a second or more; the socket path must not sit behind it).
      await this.publish(wasCreated ? 'created' : 'updated', userId);

      // Best-effort "we received your registration" push (PENDING copy). Outside the transaction
      // so a push failure can never roll back the committed registration/access change.
      await this.notifyAccessChange(lineUserId, access);

      // A fresh registration is never REJECTED — no reason to surface.
      return this.toStatusDto(access, registration, null);
    } catch (error) {
      throw this.mapRegistrationWriteError(error);
    }
  }

  /**
   * A user's self-edit of their own registration (SC-3.3). Identity is the verified `sub`; there is
   * no cross-user write.
   *
   * State gate (SC-B9): permitted ONLY while `access ∈ {PENDING, REJECTED}`. `ALLOWED`/`BLOCKED`/
   * `UNREGISTERED`/no-row → `403` (authorization-by-state), deterministic with no partial write —
   * distinct from register's duplicate-resource `409`. Options are re-validated non-deleted (`400`).
   * `richMenuType` stays `TYPE_1` (both PENDING and REJECTED derive TYPE_1).
   *
   * This path CANNOT raise a `409`: it never writes `lineUserId` (the only unique key left on
   * `LineUserRegistration`), so no duplicate-key error is reachable and `mapRegistrationWriteError`
   * is deliberately NOT wired in here — an unexpected Prisma error surfaces as a 500, not a
   * misleading conflict.
   *
   * A REJECTED caller who resubmits RE-ENTERS review: in the SAME transaction the access flips
   * `REJECTED → PENDING` and `rejectionReason` is cleared to null (invariant), and the existing
   * PENDING ack push is sent AFTER the commit (fail-soft). A PENDING caller's edit is unchanged — no
   * `LineUser` write, no push, `access` stays PENDING (Q6). Both paths return `access: PENDING`,
   * `rejectionReason: null`.
   */
  async updateRegistration(
    lineUserId: string,
    dto: UpdateLineUserRegistrationDto,
  ): Promise<LineUserStatusResponseDto> {
    const user = await this.prisma.lineUser.findFirst({
      where: { lineUserId, deletedAt: null },
      select: { id: true, access: true },
    });

    // No row, or any state other than PENDING/REJECTED, is a 403 (authorization-by-state). A
    // LIFF-first caller who never registered is UNREGISTERED → also 403 (nothing to edit); an
    // ALLOWED/BLOCKED caller cannot edit. A REJECTED caller MAY resubmit (re-enters review).
    if (
      !user ||
      (user.access !== AppAccess.PENDING && user.access !== AppAccess.REJECTED)
    ) {
      throw new ForbiddenException(REGISTRATION_NOT_EDITABLE);
    }

    const wasRejected = user.access === AppAccess.REJECTED;

    // One transaction so a partial write can't leave `access: REJECTED` with an already-edited
    // registration (or vice versa). Options are re-validated non-deleted/non-reserved (400) first,
    // mirroring register()'s shape. A REJECTED resubmit ALSO flips access → PENDING and clears the
    // reason in the SAME transaction (invariant); the PENDING-caller path performs no lineUser write.
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.assertActiveOptions(tx, dto.departmentId, dto.personnelRoleId);

      const registration = await tx.lineUserRegistration.update({
        where: { lineUserId: user.id },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          phoneDigits: toPhoneDigits(dto.phone),
          departmentId: dto.departmentId,
          personnelRoleId: dto.personnelRoleId,
        },
        select: REGISTRATION_OWNER_SELECT,
      });

      if (wasRejected) {
        await tx.lineUser.update({
          where: { id: user.id },
          data: { access: AppAccess.PENDING, rejectionReason: null },
        });
      }

      return registration;
    });

    this.logger.log(`LineUser registration edited. id=${user.id}`);

    // Emit site 3 — after the `$transaction` resolves, before the conditional PENDING push.
    await this.publish('updated', user.id);

    // A REJECTED resubmit re-enters review → send the existing PENDING ack, AFTER the transaction
    // commits (fail-soft) so a push failure can't roll back the committed resubmit. A PENDING edit
    // sends NO push (Q6). Pushed to the caller's verified U… id (the method param), never the cuid.
    if (wasRejected) {
      await this.notifyAccessChange(lineUserId, AppAccess.PENDING);
    }

    // Both paths land on PENDING with the reason cleared (REJECTED resubmit) or already null (edit).
    return this.toStatusDto(AppAccess.PENDING, updated, null);
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
      select: REGISTRATION_OWNER_SELECT,
    });
    // `rejectionReason` is non-null only when access === REJECTED (invariant) — pass it straight
    // through so the LIFF RejectedScreen can render it.
    return this.toStatusDto(user.access, registration, user.rejectionReason);
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
   * menu on LINE. Keyed on the cuid `LineUser.id`. `role` is the authenticated actor's `SystemRole`
   * (passed from the controller's session), which governs the permitted transitions (design §3).
   *
   * Role-aware read + precedence (404 BEFORE 403, so the matrix never leaks existence):
   *   1. row == null                    → 404 (both roles; unknown id, no existence leak)
   *   2. ADMIN && row.deletedAt != null → 404 (ADMIN may not act on soft-deleted — indistinguishable
   *                                            from unknown; SUPER_ADMIN can target it)
   *   3. ADMIN && !canAdminSetAccess    → 403 (role/authorization limit; the body is well-formed)
   *   4. write + drive side-effects
   *
   * SUPER_ADMIN bypasses steps 2–3 entirely (any→any, soft-deleted included).
   *
   * DB-first (design §4): the row is the source of truth, so it is written before the LINE call.
   * `accessToRichMenuType` stays the SOLE derivation. For a REACHABLE user (`deletedAt == null`):
   * `applyRichMenu` failure surfaces as a retryable `502` — a re-approve/re-block re-writes the same
   * state and re-applies the menu, idempotent on LINE (linking an already-linked menu is a no-op).
   * For a SOFT-DELETED user (only reachable by SUPER_ADMIN forcing an unfollowed account): the LINE
   * side is unreachable, so BOTH side-effects (menu apply + push) are SKIPPED — persist the DB row and
   * return 200, never a 502/500, idempotent on re-run.
   *
   * Reject (`access === REJECTED`, carrying `reason`): after the 404/403 precedence, TWO business
   * guards fire for BOTH roles (they are invariant/business rules, so the SUPER_ADMIN policy bypass
   * must NOT skip them) — (1) rejecting from UNREGISTERED is a 400 (nothing to reject), (2) a
   * missing/blank reason is a 400. Ordering is deliberate: for ADMIN an illegal `→REJECTED` from
   * UNREGISTERED is a 403 first (the policy returns false); for SUPER_ADMIN (which bypasses the 403)
   * the same case is a 400 here. On success the write persists the trimmed `reason` and the reject
   * push (`notifyRejection`) is sent instead of the ALLOWED/BLOCKED copy. The write ALSO enforces the
   * invariant: any non-REJECTED target clears `rejectionReason` to null.
   */
  async updateAccess(
    id: string,
    access: AppAccess,
    role: SystemRole,
    reason?: string,
  ): Promise<LineUserResponseDto> {
    const row = await this.prisma.lineUser.findUnique({
      where: { id },
      select: { id: true, access: true, deletedAt: true },
    });

    // 1. Unknown id → 404 for both roles. 2. For ADMIN a soft-deleted id is also a 404, byte-identical
    // to unknown (shape-oracle discipline); SUPER_ADMIN falls through and may target it.
    if (!row) throw new NotFoundException(LINE_USER_NOT_FOUND);
    if (role === SystemRole.ADMIN && row.deletedAt !== null) {
      throw new NotFoundException(LINE_USER_NOT_FOUND);
    }

    // 3. Role/authorization limit — checked AFTER the 404 precedence so it never reveals existence.
    // SUPER_ADMIN bypasses the matrix entirely.
    if (role === SystemRole.ADMIN && !canAdminSetAccess(row.access, access)) {
      throw new ForbiddenException(LINE_USER_ACCESS_TRANSITION_FORBIDDEN);
    }

    // 4. Reject business guards — fire for BOTH roles (the SUPER_ADMIN policy bypass must NOT skip
    // these) and BEFORE any write/push. UNREGISTERED-check first (nonsensical regardless of reason),
    // then the mandatory-reason check. `reason` was already trimmed by the DTO @Transform; here we
    // only test emptiness — do NOT re-trim (single normalization site).
    if (access === AppAccess.REJECTED) {
      if (row.access === AppAccess.UNREGISTERED) {
        throw new BadRequestException(CANNOT_REJECT_UNREGISTERED);
      }
      if (!reason || reason.length === 0) {
        throw new BadRequestException(REJECTION_REASON_REQUIRED);
      }
    }

    const richMenuType = accessToRichMenuType(access);
    const updated = await this.prisma.lineUser.update({
      where: { id: row.id },
      data: {
        access,
        richMenuType,
        // Invariant: set the guarded non-empty reason on REJECTED, clear it on every other target.
        // `reason!` is safe — the guard above guarantees it is non-empty when access === REJECTED.
        rejectionReason: access === AppAccess.REJECTED ? reason! : null,
      },
      select: LINE_USER_PUBLIC_FIELDS,
    });

    // Soft-deleted (SUPER_ADMIN-only reach): the account has unfollowed the OA and is unreachable on
    // LINE. Skip BOTH side-effects — linking a menu would fail (spurious 502) and the push would no-op.
    // The DB is the source of truth; persist and return 200, idempotent on re-run.
    if (row.deletedAt !== null) {
      this.logger.log(
        `LineUser access changed (soft-deleted; LINE side-effects skipped). id=${updated.id} access=${access} richMenuType=${richMenuType}`,
      );
      // NO realtime event: `publish`'s `deletedAt: null` filter would drop it anyway, and the row
      // is absent from `GET /line-users`, so broadcasting it would make every admin's table
      // disagree with a refresh. Calling `publish` here would be a no-op; not calling it is clearer.
      return this.toDto(updated);
    }

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

    // Emit site 4 — AFTER `applyRichMenu` succeeded and BEFORE the LINE push. A rich-menu failure
    // raises a retryable 502 above, and NO event is emitted on that path: broadcasting a row whose
    // LINE-side state we know is inconsistent, from a request that answers 502, is worse than being
    // briefly stale, and the retry re-emits (the operation is idempotent).
    await this.publish('updated', updated.id);

    // Best-effort notification, only after BOTH the DB write and the rich-menu apply succeeded.
    // Pushed to the LINE-side U… id (updated.lineUserId), never the cuid. A push failure here does
    // not undo the access change or the linked menu, and must not fail the request. A Reject uses the
    // separate `notifyRejection` path, whose copy comes from `buildRejectionMessage` (it interpolates
    // the mandatory reason); every other target uses the shared `ACCESS_NOTIFICATION_MESSAGES` copy
    // via `notifyAccessChange`.
    if (access === AppAccess.REJECTED) {
      await this.notifyRejection(updated.lineUserId, reason!);
    } else {
      await this.notifyAccessChange(updated.lineUserId, access);
    }

    return this.toDto(updated);
  }

  /**
   * Admin edit of a LINE user's registration fields (`PATCH /line-users/:id/registration`). Keyed on
   * the cuid `LineUser.id`. A FULL re-submit of the five editable fields; `role` is the authenticated
   * actor's `SystemRole` and governs only the soft-deleted visibility (below), NOT the fields.
   *
   * **Orthogonal to the Item 3 access matrix (AC-B9/AC-B10):** this method never reads or writes
   * `access`/`richMenuType`, never calls `updateAccess`, never applies a rich menu, and never pushes.
   * A registration edit has NO LINE side-effect — do not wire in `updateAccess` "for consistency".
   *
   * Precedence mirrors `updateAccess`'s existence-oracle discipline, then adds a registration gate:
   *   1. row == null                    → 404 LINE_USER_NOT_FOUND (both roles; no existence leak)
   *   2. ADMIN && row.deletedAt != null → 404 LINE_USER_NOT_FOUND (byte-identical to (1))
   *      // SUPER_ADMIN falls through and may edit a soft-deleted user's registration
   *   3. no registration row            → 404 LINE_USER_REGISTRATION_NOT_FOUND (distinct; not a 500)
   *   4. $transaction: assert options active/non-reserved (400), then update the row
   *   5. re-read the LineUser and return its LineUserResponseDto (200)
   *
   * `access` is deliberately NOT selected — the edit is not PENDING-gated. `assertActiveOptions` is
   * the SAME role-blind guard the LIFF self-edit uses: a system-reserved option is rejected for EVERY
   * actor, SUPER_ADMIN included (a LINE end-user is never a System Developer).
   *
   * Like the LIFF self-edit, this path CANNOT raise a `409`: none of the five editable fields is
   * unique and `lineUserId` (the only unique key) is never written, so no duplicate-key error is
   * reachable and `mapRegistrationWriteError` is deliberately NOT wired in here.
   */
  async updateRegistrationByAdmin(
    id: string,
    dto: AdminUpdateLineUserRegistrationDto,
    role: SystemRole,
  ): Promise<LineUserResponseDto> {
    // Plain reads outside the tx (mirrors updateRegistration). `access` is NOT selected — the edit is
    // orthogonal to the access matrix and is not PENDING-gated.
    const row = await this.prisma.lineUser.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });

    // 1/2. Unknown id → 404 for both roles; for ADMIN a soft-deleted id is a byte-identical 404
    // (shape-oracle discipline). SUPER_ADMIN falls through and may edit a soft-deleted user.
    if (!row) throw new NotFoundException(LINE_USER_NOT_FOUND);
    if (role === SystemRole.ADMIN && row.deletedAt !== null) {
      throw new NotFoundException(LINE_USER_NOT_FOUND);
    }

    // 3. The registration sub-resource must exist to edit. Distinct 404 (never a 500) — reachable only
    // after the user is confirmed to exist, so it leaks nothing an admin cannot already see.
    const registration = await this.prisma.lineUserRegistration.findFirst({
      where: { lineUserId: row.id, deletedAt: null },
      select: { id: true },
    });
    if (!registration) {
      throw new NotFoundException(LINE_USER_REGISTRATION_NOT_FOUND);
    }

    // One transaction so the option-validity check and the write are atomic (as `register` does).
    await this.prisma.$transaction(async (tx) => {
      await this.assertActiveOptions(tx, dto.departmentId, dto.personnelRoleId);
      await tx.lineUserRegistration.update({
        // The 1:1 key — read-only here; the identity is immutable.
        where: { lineUserId: row.id },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          phoneDigits: toPhoneDigits(dto.phone),
          departmentId: dto.departmentId,
          personnelRoleId: dto.personnelRoleId,
        },
      });
    });

    const updated = await this.prisma.lineUser.findUnique({
      where: { id: row.id },
      select: LINE_USER_PUBLIC_FIELDS,
    });

    // PII discipline: log the id only, never the submitted field values or the body. `updated` is
    // guaranteed non-null — the LineUser row is never hard-deleted, and it existed at step 1.
    this.logger.log(`LineUser registration edited by admin. id=${row.id}`);

    // Emit site 5 — after the `$transaction` and the re-read, before returning. A SUPER_ADMIN may
    // reach a soft-deleted row here; `publish`'s `deletedAt: null` filter is what stops that row
    // from being broadcast.
    await this.publish('updated', row.id);

    return this.toDto(updated!);
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
            phone: user.registration.phone,
            departmentId: user.registration.departmentId,
            department: user.registration.department.name,
            personnelRoleId: user.registration.personnelRoleId,
            personnelRole: user.registration.personnelRole.name,
          }
        : null,
    };
  }

  /**
   * A duplicate-key from the `register` write. `lineUserId` (the LineUser 1:1) is the ONLY unique key
   * left on `LineUserRegistration`, so any `P2002` here is a create race → `409 ALREADY_REGISTERED`.
   * Deliberately-thrown `HttpException`s (the 400/403/409 raised inside the flow) pass straight
   * through; anything else is rethrown unchanged.
   *
   * Wired into `register` ONLY. Neither PATCH path writes a unique column, so a duplicate key is
   * unreachable there and neither endpoint advertises a 409 any more.
   */
  private mapRegistrationWriteError(error: unknown): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(ALREADY_REGISTERED);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private toStatusDto(
    access: AppAccess,
    registration: OwnerRegistration | null,
    rejectionReason: string | null,
  ): LineUserStatusResponseDto {
    return {
      access,
      registration: registration
        ? this.toRegistrationResponseDto(registration)
        : null,
      rejectionReason,
    };
  }

  private toRegistrationResponseDto(
    registration: OwnerRegistration,
  ): LineUserRegistrationResponseDto {
    return {
      id: registration.id,
      firstName: registration.firstName,
      lastName: registration.lastName,
      phone: registration.phone,
      departmentId: registration.departmentId,
      department: registration.department.name,
      personnelRoleId: registration.personnelRoleId,
      personnelRole: registration.personnelRole.name,
      createdAt: registration.createdAt.toISOString(),
      updatedAt: registration.updatedAt.toISOString(),
    };
  }
}
