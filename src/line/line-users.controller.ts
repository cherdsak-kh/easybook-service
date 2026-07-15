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
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { LineUserResponseDto } from './dto/line-user-response.dto';
import { ListLineUsersQueryDto } from './dto/list-line-users-query.dto';
import { PaginatedLineUsersResponseDto } from './dto/paginated-line-users-response.dto';
import { UpdateLineUserAccessDto } from './dto/update-line-user-access.dto';
import { LineUserService } from './line-user.service';

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
    description: 'STAFF has no access to this collection.',
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
    summary: 'Approve or block a LINE user (update `access`).',
    description:
      'Sets `access` (Approve → ALLOWED, Block → BLOCKED). Returns the updated row. An unknown or soft-deleted id is a 404 that reveals nothing about deletion; an empty body, a bad enum value, or any extra key is a 400.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Updated.', type: LineUserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'STAFF, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  updateAccess(
    @Param('id') id: string,
    @Body() dto: UpdateLineUserAccessDto,
  ): Promise<LineUserResponseDto> {
    return this.users.updateAccess(id, dto.access);
  }
}
