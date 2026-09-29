import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedSystemUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { ListAdminNotificationsQueryDto } from './dto/notification-query.dto';
import {
  AdminNotificationDto,
  AdminNotificationUnreadCountDto,
  AdminNotificationsDismissedDto,
  AdminNotificationsUpdatedDto,
  PaginatedAdminNotificationsResponseDto,
} from './dto/notification-response.dto';
import {
  DismissAdminNotificationsDto,
  MarkAdminNotificationsReadDto,
} from './dto/notification-write.dto';
import type { NotificationCaller } from './notifications.policy';
import { NotificationsService } from './notifications.service';

/** The caller the service scopes every query to — id and role from the SESSION, never a DTO. */
const callerOf = (user: AuthenticatedSystemUser): NotificationCaller => ({
  id: user.id,
  role: user.role,
});

const UNAUTHORIZED = { description: 'No session.', type: ErrorResponseDto };
const UNAVAILABLE = {
  description: 'Session store unavailable.',
  type: ErrorResponseDto,
};
const PASSWORD_GATE = {
  description:
    'The caller must change their temporary password first (forced-reset gate).',
  type: ErrorResponseDto,
};
const WRITE_FORBIDDEN = {
  description:
    'CSRF failure, or the forced-password-change gate. Nothing is written.',
  type: ErrorResponseDto,
};
const NOT_FOUND = {
  description:
    'Unknown, malformed, role-invisible or already-dismissed id — one indistinguishable 404, never a 403. Nothing is written.',
  type: ErrorResponseDto,
};

/**
 * `การแจ้งเตือน` — the admin notification feed behind `/backend/notifications` and the topbar bell,
 * route prefix `/api/v1/notifications` (`NOTIF-API-1`, phase 1).
 *
 * ⚠️ DOCUMENTED EXCEPTION — VIEWER ON NON-GET ROUTES (D-3, AC-15, R-9). The house rule is "VIEWER may
 * read and may change nothing". The four writes here — `POST read-all`, `DELETE bulk`,
 * `PATCH :id/read`, `PATCH :id/unread` — list `VIEWER` anyway, and they are the ENTIRE allowlist of
 * VIEWER writes, because they write ONLY the caller's own `admin_notification_receipts` rows (read
 * state and "delete for me") and never an `admin_notifications` row or anyone else's state. That is
 * the roles plan §4.1's actual definition: a VIEWER may write to its own account-scoped state. Copying
 * `VIEWER` onto a route that changes SHARED state is a defect, not a precedent.
 *
 * ⚠️ NO CREATION ROUTE (D-4). A public `POST /notifications` would let any operator forge a system
 * alert for everyone; the only authors are the server's own domain events, through
 * `NotificationsService.create()` (Phase 3).
 *
 * ⚠️ CSRF APPLIES TO ALL FOUR WRITES, and nothing here is in `CSRF_EXEMPT_PATHS`/`_PATTERNS`: this
 * surface stands on an `express-session` cookie. The GETs are exempt by METHOD, not by path. The
 * forced-password-change gate applies as usual (no `@AllowPasswordChangeGate()`). Not throttled, like
 * every other staff route.
 *
 * ── ROUTE ORDER (AC-18, plan R-3) ──
 * Every literal path is declared ABOVE every `:id` path. Nothing collides today (the `:id` routes
 * are two-segment PATCHes), but a future single-segment `GET :id` / `DELETE :id` declared above
 * `unread-count` or `bulk` would swallow them — the `venues/:id` vs `/schedule` bug.
 *
 * Operation ids are Nest's default `<Class>_<method>`, so the method names are part of the Phase 2
 * contract.
 */
@ApiTags('Notifications')
@ApiCookieAuth('session')
@Controller('notifications')
@UseGuards(SessionGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'List the caller’s notifications, newest first.',
    description:
      'Scoped to the caller: only rows their role may see (`targetRole` is a MINIMUM role — SUPER_ADMIN sees ALL/ADMIN/SUPER_ADMIN, ADMIN sees ALL/ADMIN, VIEWER sees ALL) and that they have not dismissed. Ordered `createdAt DESC, id DESC` (a total order). `category`, `isRead`, `period` and `search` combine with AND. `meta.total` is the FILTERED total; a page past the end is `data: []`. `isRead`/`readAt` on each item are the CALLER’s own state. The topbar bell calls this with `limit=5`.',
  })
  @ApiOkResponse({
    description: 'The page.',
    type: PaginatedAdminNotificationsResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid query — `limit` outside 1–50, `page` < 1, an unknown `category`/`period`, `isRead` other than `true`/`false`, `search` over 100 characters, or an unrecognised parameter.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(PASSWORD_GATE)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  list(
    @Query() query: ListAdminNotificationsQueryDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<PaginatedAdminNotificationsResponseDto> {
    return this.notifications.list(callerOf(user), query);
  }

  @Get('unread-count')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'The caller’s unread counts — the bell badge and the tab pills.',
    description:
      'Unread (no `readAt` for the caller) and not dismissed, over EVERYTHING the caller can see, per category. Takes no filters: `total` always equals the sum of `byCategory` and the `meta.total` of `GET /notifications?isRead=false`.',
  })
  @ApiOkResponse({
    description: 'The counts.',
    type: AdminNotificationUnreadCountDto,
  })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(PASSWORD_GATE)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  unreadCount(
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminNotificationUnreadCountDto> {
    return this.notifications.unreadCount(callerOf(user));
  }

  // @HttpCode(200) is MANDATORY — Nest defaults POST to 201, and this creates no resource.
  @Post('read-all')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary:
      'Mark every visible unread notification read — or only the given ids.',
    description:
      'No body (or `{}`) = every notification the caller can see and has not read or dismissed. With `ids` (1–50 unique) = only those. Writes ONLY the caller’s own read state. Ids the caller cannot see, has already read, or has dismissed are skipped silently and not counted — never a 404, so this is not an existence oracle. `updated` is the number of rows whose state actually changed.',
  })
  @ApiBody({ type: MarkAdminNotificationsReadDto, required: false })
  @ApiOkResponse({
    description: 'Done.',
    type: AdminNotificationsUpdatedDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid body — `ids` empty, over 50, duplicated, `null`, or containing a non-cuid; or an unrecognised key such as `systemUserId`. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  markManyRead(
    @Body() dto: MarkAdminNotificationsReadDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminNotificationsUpdatedDto> {
    return this.notifications.markManyRead(callerOf(user), dto?.ids);
  }

  // @HttpCode(200) — explicit: this answers a count body, not 204.
  @Delete('bulk')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Delete notifications FOR THE CALLER (a per-operator dismissal).',
    description:
      'Exactly one of: `{ ids }` (1–50 unique) — dismiss those; or `{ allRead: true }` — dismiss every READ notification the caller can see, across all categories and pages, ignoring the list filters. Nothing is hard-deleted: the notification stays for every other operator, and there is no undismiss route. Invisible or already-dismissed ids are skipped silently and not counted. The body is REQUIRED on this DELETE.',
  })
  @ApiBody({ type: DismissAdminNotificationsDto, required: true })
  @ApiOkResponse({
    description: 'Done.',
    type: AdminNotificationsDismissedDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid body — both keys, neither key (or no body), `allRead` other than `true`, `ids` empty/over 50/duplicated/null/non-cuid, or an unrecognised key. The exactly-one refusal is the single string `Provide exactly one of `ids` or `allRead: true`.`. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  dismiss(
    @Body() dto: DismissAdminNotificationsDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminNotificationsDismissedDto> {
    return this.notifications.dismiss(callerOf(user), dto);
  }

  // literal routes above — a single-segment `:id` route must stay below them
  @Patch(':id/read')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Mark one notification read for the caller.',
    description:
      'Idempotent: on an already-read item it answers 200 and `readAt` does not move. Writes only the caller’s own read state. Answers with the item as the caller now sees it.',
  })
  @ApiOkResponse({ description: 'The item.', type: AdminNotificationDto })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  markRead(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminNotificationDto> {
    return this.notifications.markRead(callerOf(user), id);
  }

  @Patch(':id/unread')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Mark one notification unread for the caller.',
    description:
      'Idempotent: on an unread item it answers 200 with the item unchanged. Writes only the caller’s own read state. Answers with the item as the caller now sees it.',
  })
  @ApiOkResponse({ description: 'The item.', type: AdminNotificationDto })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  markUnread(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminNotificationDto> {
    return this.notifications.markUnread(callerOf(user), id);
  }
}
