import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminNotification,
  AdminNotificationCategory,
  AdminNotificationTargetRole,
  AdminNotificationTone,
  Prisma,
} from '@prisma/client';
import { sanitizeThaiText } from '../common/sanitize-thai.util';
import { PrismaService } from '../prisma/prisma.service';
import type { ListAdminNotificationsQueryDto } from './dto/notification-query.dto';
import type {
  AdminNotificationDto,
  AdminNotificationUnreadCountDto,
  AdminNotificationsDismissedDto,
  AdminNotificationsUpdatedDto,
  PaginatedAdminNotificationsResponseDto,
} from './dto/notification-response.dto';
import type { DismissAdminNotificationsDto } from './dto/notification-write.dto';
import {
  ADMIN_NOTIFICATION_ICONS,
  NOTIFICATION_ACTION_LABEL_MAX,
  NOTIFICATION_ACTION_URL_MAX,
  NOTIFICATION_ACTION_URL_PREFIX,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_CODE_MAX,
  NOTIFICATION_DISMISS_TARGET,
  NOTIFICATION_ID_PATTERN,
  NOTIFICATION_NOT_FOUND,
  NOTIFICATION_TITLE_MAX,
  type AdminNotificationIcon,
} from './notifications.constants';
import { periodFloor } from './notifications.period';
import {
  VISIBLE_TARGET_ROLES,
  allOf,
  readFor,
  unreadFor,
  visibleTo,
  type NotificationCaller,
} from './notifications.policy';

/** Every model column a response carries. `receipts` is added per caller by {@link selectFor}. */
const NOTIFICATION_SELECT = {
  id: true,
  category: true,
  code: true,
  title: true,
  body: true,
  tone: true,
  icon: true,
  actionUrl: true,
  actionLabel: true,
  targetRole: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AdminNotificationSelect;

/**
 * The response select plus the CALLER's receipt — and only the caller's. Prisma resolves the nested
 * relation as ONE extra query for the whole page (`notificationId IN (…) AND systemUserId = $me`, the
 * PK range), so a page costs a fixed three round trips whatever its size. Not N+1.
 *
 * 🔴 The `where` on `receipts` is the privacy boundary for the response: without it the payload would
 * carry every operator's read state.
 */
export const selectFor = (userId: string) =>
  ({
    ...NOTIFICATION_SELECT,
    receipts: {
      where: { systemUserId: userId },
      select: { readAt: true },
      take: 1,
    },
  }) satisfies Prisma.AdminNotificationSelect;

type NotificationRow = Prisma.AdminNotificationGetPayload<{
  select: ReturnType<typeof selectFor>;
}>;

/** A row as the caller sees it. `dismissedAt` and the receipt itself never leave this function. */
export function toAdminNotificationDto(
  row: NotificationRow,
): AdminNotificationDto {
  const readAt = row.receipts[0]?.readAt ?? null;
  return {
    id: row.id,
    category: row.category,
    code: row.code,
    title: row.title,
    body: row.body,
    tone: row.tone,
    icon: row.icon as AdminNotificationIcon,
    actionUrl: row.actionUrl,
    actionLabel: row.actionLabel,
    targetRole: row.targetRole,
    isRead: readAt !== null,
    readAt: readAt ? readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `search` → the term actually matched: one leading `#` stripped and re-trimmed (the DTO already
 * sanitised and trimmed it). `''` / `#` / absent → `null`, i.e. NO clause — never `contains: ''`.
 */
export function notificationSearchTerm(search?: string): string | null {
  const term = search?.trim().replace(/^#/, '').trim() ?? '';
  return term === '' ? null : term;
}

/**
 * Escapes the three LIKE metacharacters so `search` matches LITERALLY (plan §6 edge case: `%`/`_`
 * are literal text).
 *
 * 🔴 PRISMA 7 DOES NOT DO THIS FOR `contains` — the plan assumed it did. `ANNOUNCE-API-5` measured it
 * first (`escapeLike` in `announcements.service.ts`), and this module's e2e hit it again: `zqpct_%x`
 * matched `zqpctAAAx`. A local copy rather than an import across feature modules, the house idiom
 * (`feedbackSearchWhere`). The backslash is escaped too: it is Postgres' default LIKE escape.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The E-1 `where`. Exported so the unit spec can prove the composition.
 *
 * 🔴 `AND: [...]`, NEVER a spread (design §6.1): `visibleTo` and `unreadFor`/`readFor` share the
 * `receipts` key, so a spread would drop the dismissal filter.
 *
 * ⚠️ `isRead` is tested with `=== true` / `=== false`, never truthiness — a truthiness test would bring
 * the `"false"` → `true` bug back at a second layer (plan R-8).
 */
export function notificationListWhere(
  caller: NotificationCaller,
  query: Pick<ListAdminNotificationsQueryDto, 'category' | 'isRead' | 'search'>,
  floor: Date | null,
): Prisma.AdminNotificationWhereInput {
  const clauses: Prisma.AdminNotificationWhereInput[] = [visibleTo(caller)];
  if (query.category !== undefined) clauses.push({ category: query.category });
  if (query.isRead === true) clauses.push(readFor(caller.id));
  else if (query.isRead === false) clauses.push(unreadFor(caller.id));
  if (floor) clauses.push({ createdAt: { gte: floor } });
  const term = notificationSearchTerm(query.search);
  if (term !== null) {
    const like = { contains: escapeLike(term), mode: 'insensitive' } as const;
    clauses.push({ OR: [{ title: like }, { body: like }, { code: like }] });
  }
  return allOf(...clauses);
}

/** `groupBy(category)` rows → all four keys (a missing group is 0) and their sum. */
export function toUnreadCount(
  groups: { category: AdminNotificationCategory; _count: { _all: number } }[],
): AdminNotificationUnreadCountDto {
  const byCategory: Record<AdminNotificationCategory, number> = {
    BOOKING: 0,
    REGISTRATION: 0,
    FEEDBACK: 0,
    SYSTEM: 0,
  };
  for (const g of groups) byCategory[g.category] = g._count._all;
  const total = Object.values(byCategory).reduce((n, c) => n + c, 0);
  return { total, byCategory };
}

/** What Phase 3 listeners pass to {@link NotificationsService.create} (design §7). */
export interface CreateAdminNotificationInput {
  category: AdminNotificationCategory;
  tone: AdminNotificationTone;
  icon: AdminNotificationIcon;
  /** Required; sanitised (which trims) → 1..200. */
  title: string;
  /** Required; sanitised → 1..1000. */
  body: string;
  /** Trimmed; `''` → null; ≤ 64. */
  code?: string | null;
  /** Both-or-neither with `actionLabel` (S-8). `/backend/…` only (D-7). */
  actionUrl?: string | null;
  /** Sanitised; 1..60 when present. */
  actionLabel?: string | null;
  /** Default `ALL`. */
  targetRole?: AdminNotificationTargetRole;
}

/** Whitespace or a control character anywhere in a deep link. */
// eslint-disable-next-line no-control-regex
const URL_FORBIDDEN_CHARS = /[\s\u0000-\u001f\u007f]/;

const isOneOf = <T extends string>(values: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v);

/**
 * `create()`'s input check, pure so it is unit-tested without Prisma (AC-17). Throws a plain `Error`
 * — a malformed notification is a PROGRAMMER error in a Phase 3 listener, never an HTTP answer.
 *
 * 🔴 PDPA: no message here interpolates the title, body or label. Only field names and enum values.
 */
export function normaliseCreateInput(
  input: CreateAdminNotificationInput,
): Prisma.AdminNotificationCreateInput {
  const fail = (what: string): never => {
    throw new Error(`AdminNotification.create: ${what}`);
  };

  if (!isOneOf(Object.values(AdminNotificationCategory), input.category))
    fail('unknown category');
  if (!isOneOf(Object.values(AdminNotificationTone), input.tone))
    fail('unknown tone');
  if (!isOneOf(ADMIN_NOTIFICATION_ICONS, input.icon)) fail('unknown icon');
  const targetRole = input.targetRole ?? AdminNotificationTargetRole.ALL;
  if (!isOneOf(Object.values(AdminNotificationTargetRole), targetRole))
    fail('unknown targetRole');

  const text = (field: string, value: unknown, max: number): string => {
    if (typeof value !== 'string') return fail(`${field} must be a string`);
    const clean = sanitizeThaiText({ value }) as string;
    if (clean.length < 1 || clean.length > max)
      fail(`${field} must be 1..${max} characters`);
    return clean;
  };
  const title = text('title', input.title, NOTIFICATION_TITLE_MAX);
  const body = text('body', input.body, NOTIFICATION_BODY_MAX);

  let code: string | null = null;
  if (input.code !== undefined && input.code !== null) {
    if (typeof input.code !== 'string') fail('code must be a string');
    const trimmed = input.code.trim();
    if (trimmed.length > NOTIFICATION_CODE_MAX)
      fail(`code must be at most ${NOTIFICATION_CODE_MAX} characters`);
    code = trimmed === '' ? null : trimmed;
  }

  const rawUrl = input.actionUrl ?? null;
  const rawLabel = input.actionLabel ?? null;
  if ((rawUrl === null) !== (rawLabel === null))
    fail('actionUrl and actionLabel must both be set or both be null');

  let actionUrl: string | null = null;
  let actionLabel: string | null = null;
  if (rawUrl !== null && rawLabel !== null) {
    if (typeof rawUrl !== 'string') fail('actionUrl must be a string');
    if (
      rawUrl.length > NOTIFICATION_ACTION_URL_MAX ||
      !rawUrl.startsWith(NOTIFICATION_ACTION_URL_PREFIX) ||
      rawUrl.includes('//') ||
      rawUrl.includes('\\') ||
      URL_FORBIDDEN_CHARS.test(rawUrl)
    )
      fail(
        `actionUrl must be a portal-relative path starting with ${NOTIFICATION_ACTION_URL_PREFIX}`,
      );
    actionUrl = rawUrl;
    actionLabel = text('actionLabel', rawLabel, NOTIFICATION_ACTION_LABEL_MAX);
  }

  return {
    category: input.category,
    tone: input.tone,
    icon: input.icon,
    title,
    body,
    code,
    actionUrl,
    actionLabel,
    targetRole,
  };
}

/**
 * `NOTIF-API-1` — the caller-scoped admin notification feed (design §6).
 *
 * ── THE TWO RULES EVERY METHOD FOLLOWS ──
 * 1. **Visibility lives in the query**, never in a check after a read: every method starts from
 *    `visibleTo(caller)` (or, in the one raw statement, from the same `VISIBLE_TARGET_ROLES`).
 *    Invisible = 404 on single-id routes and silently skipped on bulk routes — never a 403, so no
 *    route is an existence oracle.
 * 2. **Only the caller's own receipt rows are ever written.** No method updates or deletes an
 *    `admin_notifications` row; "delete" is a per-operator dismissal (D-3).
 *
 * 🔴 PDPA: `title`/`body` carry names and phone numbers. Log lines carry `id=` / `user=` / `count=`
 * only — never a title, a body or a search term.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** E-1 — one page, newest first (`createdAt DESC, id DESC`, a total order), and the FILTERED total. */
  async list(
    caller: NotificationCaller,
    query: ListAdminNotificationsQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedAdminNotificationsResponseDto> {
    const where = notificationListWhere(
      caller,
      query,
      periodFloor(query.period, now),
    );
    // `Promise.all`, not `$transaction` — the house read pattern (`AdminFeedbackService.list`).
    const [rows, total] = await Promise.all([
      this.prisma.adminNotification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: selectFor(caller.id),
      }),
      this.prisma.adminNotification.count({ where }),
    ]);
    return {
      data: rows.map(toAdminNotificationDto),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
      },
    };
  }

  /**
   * E-2 — unread counts per category over everything visible, unaffected by any list filter.
   *
   * EXACTLY the predicate E-1 uses for `isRead=false` with no other filter, which is what makes
   * "E-2 total == E-1 `?isRead=false` meta.total" hold by construction (AC-6).
   */
  async unreadCount(
    caller: NotificationCaller,
  ): Promise<AdminNotificationUnreadCountDto> {
    const groups = await this.prisma.adminNotification.groupBy({
      by: ['category'],
      where: allOf(visibleTo(caller), unreadFor(caller.id)),
      _count: { _all: true },
    });
    return toUnreadCount(groups);
  }

  /** E-3 — idempotent: a second call answers 200 and `readAt` does not move (AC-11). */
  async markRead(
    caller: NotificationCaller,
    id: string,
  ): Promise<AdminNotificationDto> {
    await this.assertVisible(caller, id);
    await this.markManyRead(caller, [id]);
    return this.readOne(caller, id);
  }

  /**
   * E-4 — clears the caller's `readAt`. It NEVER creates a receipt row: no row already means unread,
   * so an unread item is a 200 no-op.
   */
  async markUnread(
    caller: NotificationCaller,
    id: string,
  ): Promise<AdminNotificationDto> {
    await this.assertVisible(caller, id);
    const { count } = await this.prisma.adminNotificationReceipt.updateMany({
      where: {
        systemUserId: caller.id,
        notificationId: id,
        readAt: { not: null },
      },
      data: { readAt: null },
    });
    this.logger.debug(
      `Notification marked unread id=${id} user=${caller.id} changed=${count}`,
    );
    return this.readOne(caller, id);
  }

  /**
   * E-5 (and the write half of E-3) — ONE set-based statement (design S-11, plan R-6).
   *
   * Without `ids` the target is the caller's whole visible unread backlog, which is unbounded (a new
   * operator starts with the entire history unread, OPEN-A). `INSERT … SELECT … ON CONFLICT` marks it
   * atomically without pulling the id list into memory, and its affected-row count is exactly "rows
   * that changed" (inserted + conflict-updated), which is the `updated` the toast shows.
   *
   * - The `NOT EXISTS` and the `DO UPDATE … WHERE` both skip a row that is already read (so `readAt`
   *   never moves, AC-11) or dismissed (so a dismissed row is never resurrected).
   * - 🔴 This statement MIRRORS `visibleTo` (role list + not dismissed) because raw SQL cannot call
   *   it. The role list comes from the same `VISIBLE_TARGET_ROLES` constant, never a copy.
   * - `Prisma.sql` tagged template only — every value is a bind parameter. NEVER `$executeRawUnsafe`.
   */
  async markManyRead(
    caller: NotificationCaller,
    ids?: string[],
    now: Date = new Date(),
  ): Promise<AdminNotificationsUpdatedDto> {
    const roles = [...VISIBLE_TARGET_ROLES[caller.role]];
    const idFilter = ids
      ? Prisma.sql`AND n.id = ANY(${ids}::text[])`
      : Prisma.empty;
    const updated = await this.prisma.$executeRaw`
      INSERT INTO admin_notification_receipts ("systemUserId", "notificationId", "readAt")
      SELECT ${caller.id}, n.id, ${now}
      FROM admin_notifications n
      WHERE n."targetRole"::text = ANY(${roles}::text[])
        ${idFilter}
        AND NOT EXISTS (
          SELECT 1 FROM admin_notification_receipts r
          WHERE r."systemUserId" = ${caller.id} AND r."notificationId" = n.id
            AND (r."readAt" IS NOT NULL OR r."dismissedAt" IS NOT NULL))
      ON CONFLICT ("systemUserId", "notificationId") DO UPDATE
        SET "readAt" = EXCLUDED."readAt"
        WHERE admin_notification_receipts."readAt" IS NULL
          AND admin_notification_receipts."dismissedAt" IS NULL`;
    this.logger.log(
      `Notifications marked read user=${caller.id} scope=${ids ? `ids(${ids.length})` : 'all'} count=${updated}`,
    );
    return { updated };
  }

  /**
   * E-6 — "delete for ME": sets the caller's `dismissedAt`. No notification row is ever deleted (D-3,
   * AC-16).
   *
   * The exactly-one rule is checked HERE, before any query (design S-9): a class-validator decorator
   * cannot catch the "neither" case, because `@ValidateIf` suppresses every constraint on its key.
   */
  async dismiss(
    caller: NotificationCaller,
    dto: DismissAdminNotificationsDto | undefined,
    now: Date = new Date(),
  ): Promise<AdminNotificationsDismissedDto> {
    const ids = dto?.ids;
    const allRead = dto?.allRead;
    if ((ids === undefined) === (allRead === undefined))
      throw new BadRequestException(NOTIFICATION_DISMISS_TARGET);

    let deleted: number;
    if (allRead === true) {
      // "Read" implies a receipt row exists, so no insert is needed. The list filters are ignored on
      // purpose (plan §3, prototype ~21166): every read row the caller can see, every page and tab.
      const { count } = await this.prisma.adminNotificationReceipt.updateMany({
        where: {
          systemUserId: caller.id,
          readAt: { not: null },
          dismissedAt: null,
          notification: {
            targetRole: { in: [...VISIBLE_TARGET_ROLES[caller.role]] },
          },
        },
        data: { dismissedAt: now },
      });
      deleted = count;
    } else {
      deleted = await this.dismissIds(caller, ids ?? [], now);
    }
    this.logger.log(
      `Notifications dismissed user=${caller.id} scope=${allRead ? 'allRead' : `ids(${ids?.length ?? 0})`} count=${deleted}`,
    );
    return { deleted };
  }

  /**
   * ≤ 50 ids: resolve the visible ones, then insert a dismissed receipt where none exists and stamp
   * the existing ones. Two related writes, so one transaction. Rows created by the insert already carry
   * `dismissedAt`, so the update cannot count them twice.
   */
  private dismissIds(
    caller: NotificationCaller,
    ids: string[],
    now: Date,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const targets = await tx.adminNotification.findMany({
        where: allOf(visibleTo(caller), { id: { in: ids } }),
        select: { id: true },
      });
      if (targets.length === 0) return 0;
      const targetIds = targets.map((t) => t.id);
      const created = await tx.adminNotificationReceipt.createMany({
        data: targetIds.map((notificationId) => ({
          systemUserId: caller.id,
          notificationId,
          dismissedAt: now,
        })),
        skipDuplicates: true,
      });
      const updated = await tx.adminNotificationReceipt.updateMany({
        where: {
          systemUserId: caller.id,
          notificationId: { in: targetIds },
          dismissedAt: null,
        },
        data: { dismissedAt: now },
      });
      return created.count + updated.count;
    });
  }

  /**
   * The Phase 3 entry point (D-4) — there is NO public creation route. Validates in the service
   * (required fields, enums, icon list, `/backend/` deep link, CTA pairing) and returns the created
   * row. Creates no receipt rows: "no row = unread" keeps this O(1) with no fan-out (D-1).
   */
  async create(
    input: CreateAdminNotificationInput,
  ): Promise<AdminNotification> {
    const data = normaliseCreateInput(input);
    const row = await this.prisma.adminNotification.create({ data });
    this.logger.log(
      `Notification created id=${row.id} category=${row.category} targetRole=${row.targetRole}`,
    );
    return row;
  }

  /**
   * The single-id 404 gate. A path id that is not a cuid is the same 404 without a query (never a
   * 400 — design §3). Unknown, role-invisible and dismissed are indistinguishable.
   */
  private async assertVisible(
    caller: NotificationCaller,
    id: string,
  ): Promise<void> {
    if (!NOTIFICATION_ID_PATTERN.test(id))
      throw new NotFoundException(NOTIFICATION_NOT_FOUND);
    const hit = await this.prisma.adminNotification.findFirst({
      where: allOf(visibleTo(caller), { id }),
      select: { id: true },
    });
    if (!hit) throw new NotFoundException(NOTIFICATION_NOT_FOUND);
  }

  /** The item as the caller now sees it (design S-4). */
  private async readOne(
    caller: NotificationCaller,
    id: string,
  ): Promise<AdminNotificationDto> {
    const row = await this.prisma.adminNotification.findFirst({
      where: allOf(visibleTo(caller), { id }),
      select: selectFor(caller.id),
    });
    if (!row) throw new NotFoundException(NOTIFICATION_NOT_FOUND);
    return toAdminNotificationDto(row);
  }
}
