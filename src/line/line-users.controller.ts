import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
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
import { AdminUpdateLineUserRegistrationDto } from './dto/admin-update-line-user-registration.dto';
import { LineUserResponseDto } from './dto/line-user-response.dto';
import { ListLineUsersQueryDto } from './dto/list-line-users-query.dto';
import { PaginatedLineUsersResponseDto } from './dto/paginated-line-users-response.dto';
import { UpdateLineUserAccessDto } from './dto/update-line-user-access.dto';
import type { AdminActor } from './line-user.service';
import { LineUserService } from './line-user.service';

/**
 * The acting operator, for the policy AND for the realtime event (REALTIME-1).
 *
 * `name` is the display name a colleague already sees on the staff screen — no email, no role,
 * nothing an event needs to be an audit record rather than a "who just did that?" answer.
 */
const actorOf = (user: AuthenticatedSystemUser): AdminActor => ({
  id: user.id,
  name: `${user.firstName} ${user.lastName}`.trim(),
  role: user.role,
});

/**
 * Back-office management of LINE end-users. Route prefix: `/api/v1/line-users`.
 *
 * Session-guarded (`SUPER_ADMIN`/`ADMIN` only) and keyed on the cuid `LineUser.id`. The former
 * standalone `PATCH /line/users/:lineUserId/rich-menu` route was removed — rich-menu switching is
 * now derived from `access` via `LineUserService.updateAccess` (see
 * claude_planning/20260714_1742_line_user_registration/).
 *
 * `@Roles(...)` is the sole authorization gate here: unlike `/system-users`, this resource has no
 * target-dependent policy (approve/block is a straight write of one field), so no policy file exists.
 * CSRF on the PATCH is enforced by the global middleware (`configureApp`), not decorated per-route;
 * it is documented with `@ApiHeader({ name: 'x-csrf-token' })` exactly as `PATCH /system-users/:id`.
 */
@ApiTags('LINE Users')
@ApiCookieAuth('session')
@Controller('line-users')
@UseGuards(SessionGuard, RolesGuard)
export class LineUsersController {
  constructor(private readonly users: LineUserService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'List LINE users, paginated.',
    description:
      'Soft-deleted rows are excluded from `data` and from `meta.total`. Optional `search` is a case-insensitive substring match on `displayName`; optional `access` narrows to one state. Ordered `followedAt DESC, id DESC`. A page beyond the last one is a 200 with an empty `data`, not a 404.',
  })
  @ApiOkResponse({
    description: 'A page of LINE users.',
    type: PaginatedLineUsersResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER has no access to this collection.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @Query() query: ListLineUsersQueryDto,
  ): Promise<PaginatedLineUsersResponseDto> {
    return this.users.findManyPaginated(query);
  }

  // `:id` is an opaque, unvalidated string on purpose — same rationale as `/system-users/:id`: a
  // format check would turn a malformed id into a 400 while an absent id stayed 404, a shape oracle.
  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Approve, block, or reject a LINE user (update `access`).',
    description:
      'Sets `access` (Approve → ALLOWED, Block → BLOCKED, Reject → REJECTED). Returns the updated row. ADMIN is bound by the transition matrix (may only reach ALLOWED/BLOCKED/REJECTED, and not from UNREGISTERED); SUPER_ADMIN may set any state and may target soft-deleted rows. Rejecting REQUIRES a non-empty `reason` (pushed to the user and shown in the LIFF app): a missing/blank reason, or a reject from UNREGISTERED (SUPER_ADMIN reach), is a 400. An empty body, a bad enum value, an over-500-char `reason`, or any extra key is a 400.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Updated.', type: LineUserResponseDto })
  @ApiBadRequestResponse({
    description:
      'An empty body, a bad enum value, a non-string or over-500-char `reason`, an extra key; a REJECTED request with a missing/blank `reason`; or a REJECTED request from UNREGISTERED (SUPER_ADMIN reach).',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'VIEWER; CSRF failure; or an access transition not permitted for ADMIN.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description:
      'Unknown id (both roles); a soft-deleted id is 404 for ADMIN but targetable by SUPER_ADMIN. Reveals nothing about deletion.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  updateAccess(
    @Param('id') id: string,
    @Body() dto: UpdateLineUserAccessDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<LineUserResponseDto> {
    return this.users.updateAccess(id, dto.access, actorOf(user), dto.reason);
  }

  // Two path segments (`:id/registration`) — cannot collide with the single-segment admin `:id` or
  // the LIFF literal `PATCH /line-users/registration`. Independent of the Item 3 access endpoint: a
  // registration edit has NO access side-effect (no matrix, no rich menu, no push). `:id` stays an
  // opaque, unvalidated string, same shape-oracle rationale as `updateAccess`.
  @Patch(':id/registration')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: "Edit a LINE user's registration fields (admin).",
    description:
      'Full re-submit of firstName, lastName, phone, departmentId, personnelRoleId. Does NOT change `access` or the rich menu — it is orthogonal to the approve/block transition matrix. Both ADMIN and SUPER_ADMIN may edit. A system-reserved or soft-deleted option id is rejected for every actor (400). For ADMIN a soft-deleted user is 404; SUPER_ADMIN may edit one, with no LINE side-effect.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Updated.', type: LineUserResponseDto })
  @ApiBadRequestResponse({
    description:
      'Malformed/blank field, bad phone, an extra key (including `lineUserId`), or a deleted/unknown/system-reserved option id.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or a CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description:
      'Unknown id (both roles); a soft-deleted id for ADMIN; or the user exists but has no registration to edit.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  updateRegistrationByAdmin(
    @Param('id') id: string,
    @Body() dto: AdminUpdateLineUserRegistrationDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<LineUserResponseDto> {
    return this.users.updateRegistrationByAdmin(id, dto, actorOf(user));
  }
}
