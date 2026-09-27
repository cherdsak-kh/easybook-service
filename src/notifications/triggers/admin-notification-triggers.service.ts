import { Inject, Injectable, Logger } from '@nestjs/common';
import { BookingStatus, FeedbackType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
} from '../notifications.constants';
import {
  NotificationsService,
  type CreateAdminNotificationInput,
} from '../notifications.service';
import {
  ATTRIBUTION_SELECT,
  formatActor,
  type PersonFacts,
} from './attribution';
import {
  buildB1,
  buildB2,
  buildB3,
  buildB4,
  buildB5,
  buildC1,
  buildC2,
  buildC3,
  buildC4,
  buildC5,
  buildF1,
  buildF2,
  buildU1,
  buildU2,
  buildU3,
  clip,
} from './builders';
import {
  ADMIN_NOTIFICATION_TRIGGERS_ENABLED,
  CODE_LIST_MAX,
  LINE_FAILURE_DEDUPE_TTL_SEC,
  SERVER_ERROR_DEDUPE_TTL_SEC,
  isDeniedSettingKey,
  isLineFailureKind,
  lineFailureDedupeKey,
  serverErrorDedupeKey,
  SETTING_CHANGE_ALLOWLIST,
} from './triggers.constants';
// `import type` only — erased at build (design §2.1's file-level import rule permits this).
import type { LineErrorKind } from '../../line/line-call-error';

/** Structural: satisfied by `RealtimeActor`, `bookings`' `Actor` and `line`'s `AdminActor`. */
export interface NotificationActor {
  id: string;
  name: string;
}

/**
 * A use-case tag for the fail-safe wrapper's log line — plain `string` rather than a closed union,
 * because `feedbackSubmitted` does not know whether it is F1 or F2 until its read resolves (hence
 * the joint `'F1/F2'` tag on that one call site).
 */
export type TriggerUc = string;

/**
 * Only the error class name, plus `:<code>` for a known Prisma error. NEVER `error.message` — a
 * `PrismaClientValidationError` message embeds the call's argument values, including names and
 * phone numbers (D-8). The one exception: `AdminNotification.create: …` messages are ours and name
 * only a field, so they are safe to log verbatim.
 */
export function safeReason(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.startsWith('AdminNotification.create:')
  ) {
    return error.message;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.constructor.name}:${error.code}`;
  }
  if (error instanceof Error) return error.constructor.name;
  return 'UnknownError';
}

const ACTOR_READ_SELECT = ATTRIBUTION_SELECT;

/**
 * `NOTIF-EVENTS-1` — one injectable per the plan's 15 use cases (design §2.3).
 *
 * `NotificationsModule` keeps `imports: []`; this depends only on the globals (`PrismaService`,
 * `RedisService`) and `NotificationsService`, so `LineModule`, `BookingsModule`, `FeedbackModule`
 * and `VenuesModule` can import `NotificationsModule` with no cycle and no `forwardRef`.
 *
 * ── THE FAIL-SAFE CONTRACT (hard requirement) ──
 * Every public method here is `return this.run(uc, ids, async () => {...})` and NOTHING else. `run`
 * NEVER rejects: disabled ⇒ no read, no Redis, no write; a `work()` returning `null` ⇒ the firing
 * condition was not met; a thrown error is caught and logged at `warn` with the UC id and ids only.
 * Callers `await` every method AFTER their write has committed, with `PrismaService`, never a
 * `TransactionClient` — and never wrap it in their own try/catch (the contract lives here).
 */
@Injectable()
export class AdminNotificationTriggers {
  private readonly logger = new Logger(AdminNotificationTriggers.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(ADMIN_NOTIFICATION_TRIGGERS_ENABLED)
    private readonly enabled: boolean,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** THE fail-safe wrapper. See the class doc — every public method is exactly this call. */
  private async run(
    uc: TriggerUc,
    ids: string,
    work: () => Promise<CreateAdminNotificationInput | null>,
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      const input = await work();
      if (input === null) return;
      await this.notifications.create({
        ...input,
        title: clip(input.title, NOTIFICATION_TITLE_MAX),
        body: clip(input.body, NOTIFICATION_BODY_MAX),
      });
    } catch (error) {
      this.logger.warn(
        `Admin notification skipped uc=${uc} ${ids} reason=${safeReason(error)}`,
      );
    }
  }

  /**
   * The acting `SystemUser`'s attribution text (R-8). A failed or empty read degrades to the bare
   * actor name — it never drops the notification. Deliberately swallows its own error: a broken
   * actor read must not stop the trigger from firing.
   */
  private async actorText(actor: NotificationActor): Promise<string> {
    try {
      const row = await this.prisma.systemUser.findUnique({
        where: { id: actor.id },
        select: ACTOR_READ_SELECT,
      });
      if (!row) return formatActor(actor.name, null, null);
      return (
        formatActor(
          `${row.firstName} ${row.lastName}`,
          row.personnelRole?.name ?? null,
          row.department?.name ?? null,
        ) || formatActor(actor.name, null, null)
      );
    } catch {
      return formatActor(actor.name, null, null);
    }
  }

  // ── U1 / U2 / U3 — REGISTRATION ─────────────────────────────────────────────────────────────

  /** U1 — UNREGISTERED→PENDING. Zero reads: the caller passes the row it already holds. */
  registrationSubmitted(p: {
    lineUserId: string;
    person: PersonFacts & { phone: string };
  }): Promise<void> {
    return this.run('U1', `lineUser=${p.lineUserId}`, () =>
      Promise.resolve(buildU1(p.person)),
    );
  }

  /** U2 — REJECTED→PENDING resubmit. Zero reads. */
  registrationResubmitted(p: {
    lineUserId: string;
    person: PersonFacts;
  }): Promise<void> {
    return this.run('U2', `lineUser=${p.lineUserId}`, () =>
      Promise.resolve(buildU2(p.person)),
    );
  }

  /** U3 — an unfollow while ≥1 request is PENDING (R-6). One read; null when the count is 0. */
  unfollowedWithPending(p: { lineUserId: string }): Promise<void> {
    return this.run('U3', `lineUser=${p.lineUserId}`, async () => {
      const row = await this.prisma.lineUser.findUnique({
        where: { id: p.lineUserId },
        select: {
          access: true,
          registration: { select: ATTRIBUTION_SELECT },
          bookingRequests: {
            where: { status: BookingStatus.PENDING },
            select: { code: true },
            orderBy: { firstStartAt: 'asc' },
            take: CODE_LIST_MAX,
          },
          _count: {
            select: {
              bookingRequests: { where: { status: BookingStatus.PENDING } },
            },
          },
        },
      });
      const pendingCount = row?._count.bookingRequests ?? 0;
      if (!row || pendingCount === 0) return null;
      return buildU3({
        registration: row.registration,
        access: row.access,
        pendingCount,
        pendingCodes: row.bookingRequests.map((b) => b.code),
      });
    });
  }

  // ── B1 / B2 / B3 / B4 / B5 — BOOKING ────────────────────────────────────────────────────────

  /** B1 — a new LIFF submission. One read. */
  bookingRequested(p: { bookingId: string }): Promise<void> {
    return this.run('B1', `booking=${p.bookingId}`, async () => {
      const row = await this.prisma.bookingRequest.findUnique({
        where: { id: p.bookingId },
        select: {
          code: true,
          venue: { select: { name: true } },
          lineUser: {
            select: { registration: { select: ATTRIBUTION_SELECT } },
          },
          slots: {
            where: { isCancelled: false },
            select: { startAt: true, endAt: true },
          },
        },
      });
      if (!row) return null;
      return buildB1({
        code: row.code,
        venueName: row.venue.name,
        slots: row.slots,
        requester: row.lineUser?.registration ?? null,
      });
    });
  }

  /** B2 — the requester cancelled (whole request or one slot). One read. */
  bookingCancelledByRequester(p: {
    bookingId: string;
    slotId?: string;
  }): Promise<void> {
    return this.run(
      'B2',
      `booking=${p.bookingId}${p.slotId ? ` slot=${p.slotId}` : ''}`,
      async () => {
        const row = await this.prisma.bookingRequest.findUnique({
          where: { id: p.bookingId },
          select: {
            code: true,
            venue: { select: { name: true } },
            lineUser: {
              select: { registration: { select: ATTRIBUTION_SELECT } },
            },
            slots: p.slotId
              ? {
                  where: { id: p.slotId },
                  select: { startAt: true, endAt: true },
                }
              : { select: { startAt: true, endAt: true } },
          },
        });
        if (!row) return null;
        return buildB2({
          code: row.code,
          venueName: row.venue.name,
          slots: row.slots,
          requester: row.lineUser?.registration ?? null,
          slotOnly: p.slotId !== undefined,
        });
      },
    );
  }

  /** B3 — one sweep's worth of expiries, however many rows it flipped (R-2). One read. */
  bookingsExpired(p: { bookingIds: readonly string[] }): Promise<void> {
    return this.run('B3', `count=${p.bookingIds.length}`, async () => {
      if (p.bookingIds.length === 0) return null;
      const rows = await this.prisma.bookingRequest.findMany({
        where: { id: { in: [...p.bookingIds].slice(0, CODE_LIST_MAX) } },
        select: {
          code: true,
          firstStartAt: true,
          venue: { select: { name: true } },
        },
        orderBy: { firstStartAt: 'asc' },
      });
      return buildB3({
        count: p.bookingIds.length,
        codes: rows.map((r) => r.code),
        single:
          p.bookingIds.length === 1 && rows[0]
            ? { venueName: rows[0].venue.name, startAt: rows[0].firstStartAt }
            : undefined,
      });
    });
  }

  /** B4 — ADR-001 auto-rejected N losers (approve or direct-create). Two reads, in parallel. */
  bookingsAutoRejected(p: {
    approvedBookingId: string;
    losers: readonly { id: string; code: string }[];
    actor: NotificationActor;
  }): Promise<void> {
    return this.run(
      'B4',
      `booking=${p.approvedBookingId} losers=${p.losers.length}`,
      async () => {
        if (p.losers.length === 0) return null;
        const [approved, actorText] = await Promise.all([
          this.prisma.bookingRequest.findUnique({
            where: { id: p.approvedBookingId },
            select: { code: true, venue: { select: { name: true } } },
          }),
          this.actorText(p.actor),
        ]);
        if (!approved) return null;
        return buildB4({
          approvedCode: approved.code,
          venueName: approved.venue.name,
          loserCodes: p.losers.map((l) => l.code),
          actorText,
        });
      },
    );
  }

  /** B5 — a staff direct booking, born APPROVED. Two reads, in parallel. */
  directBookingCreated(p: {
    bookingId: string;
    actor: NotificationActor;
  }): Promise<void> {
    return this.run('B5', `booking=${p.bookingId}`, async () => {
      const [row, actorText] = await Promise.all([
        this.prisma.bookingRequest.findUnique({
          where: { id: p.bookingId },
          select: {
            code: true,
            venue: { select: { name: true } },
            slots: {
              where: { isCancelled: false },
              select: { startAt: true, endAt: true },
            },
          },
        }),
        this.actorText(p.actor),
      ]);
      if (!row) return null;
      return buildB5({
        code: row.code,
        venueName: row.venue.name,
        slots: row.slots,
        actorText,
      });
    });
  }

  // ── F1 / F2 — FEEDBACK ──────────────────────────────────────────────────────────────────────

  /** F1 (FEEDBACK) / F2 (ISSUE) — one submission, split by `type`. One read. */
  feedbackSubmitted(p: { feedbackId: string }): Promise<void> {
    return this.run('F1/F2', `feedback=${p.feedbackId}`, async () => {
      const row = await this.prisma.feedback.findUnique({
        where: { id: p.feedbackId },
        select: {
          code: true,
          type: true,
          subject: true,
          venue: { select: { name: true } },
          lineUser: {
            select: { registration: { select: ATTRIBUTION_SELECT } },
          },
        },
      });
      if (!row) return null;
      const reporter = row.lineUser?.registration ?? null;
      if (row.type === FeedbackType.ISSUE) {
        return buildF2({
          code: row.code,
          subject: row.subject,
          venueName: row.venue?.name ?? null,
          reporter,
        });
      }
      return buildF1({ code: row.code, subject: row.subject, reporter });
    });
  }

  // ── C1 … C5 — SYSTEM ────────────────────────────────────────────────────────────────────────

  /**
   * C1 — a classified LINE delivery failure. Fires only for `NOT_CONFIGURED` / `RATE_LIMITED` /
   * `TRANSIENT` — `REJECTED` (a bad recipient/payload) and `ALREADY_ACCEPTED` never fire. Deduped
   * per kind per hour. Zero reads.
   */
  lineDeliveryFailed(p: {
    operation: 'push' | 'multicast';
    kind: LineErrorKind;
    status: number | null;
    at?: Date;
  }): Promise<void> {
    return this.run('C1', `op=${p.operation} kind=${p.kind}`, async () => {
      if (!isLineFailureKind(p.kind)) return null;
      const claimed = await this.redis.claimOnce(
        lineFailureDedupeKey(p.kind),
        LINE_FAILURE_DEDUPE_TTL_SEC,
      );
      if (!claimed) return null;
      return buildC1({
        operation: p.operation,
        kind: p.kind,
        status: p.status,
        at: p.at ?? new Date(),
      });
    });
  }

  /** C2 — the app version changed since the last announcement. Zero reads (the caller/announcer read it). */
  versionChanged(p: { previous: string; current: string }): Promise<void> {
    return this.run('C2', `${p.previous}->${p.current}`, () =>
      Promise.resolve(buildC2(p)),
    );
  }

  /** C3 — a venue closed. One read (the acting operator). */
  venueClosed(p: {
    venueId: string;
    venueName: string;
    reason: string;
    actor: NotificationActor;
  }): Promise<void> {
    return this.run('C3', `venue=${p.venueId}`, async () => {
      const actorText = await this.actorText(p.actor);
      return buildC3({ venueName: p.venueName, reason: p.reason, actorText });
    });
  }

  /** C4 — an allowlisted operational setting changed. Dormant until a writer exists (R-5). */
  settingChanged(p: {
    key: string;
    oldValue: string | null;
    newValue: string;
    actor: NotificationActor;
  }): Promise<void> {
    return this.run('C4', `key=${p.key}`, async () => {
      if (isDeniedSettingKey(p.key)) return null;
      if (!SETTING_CHANGE_ALLOWLIST.includes(p.key)) return null;
      if (p.oldValue === p.newValue) return null;
      const actorText = await this.actorText(p.actor);
      return buildC4({
        key: p.key,
        oldValue: p.oldValue,
        newValue: p.newValue,
        actorText,
      });
    });
  }

  /** C5 — an unhandled 5xx. Deduped per signature per 15 min. Zero reads. */
  serverError(p: {
    status: number;
    errorCode: string;
    handler: string;
    method: string;
    routeTemplate: string | null;
  }): Promise<void> {
    return this.run(
      'C5',
      `${p.method} ${p.routeTemplate ?? p.handler} ${p.errorCode}`,
      async () => {
        const claimed = await this.redis.claimOnce(
          serverErrorDedupeKey(p),
          SERVER_ERROR_DEDUPE_TTL_SEC,
        );
        if (!claimed) return null;
        return buildC5(p);
      },
    );
  }
}
