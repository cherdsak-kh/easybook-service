import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
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
import { mayUseSystemReservedOptions } from '../system-users/system-users.policy';
import type { Actor } from '../system-users/system-users.policy';
import {
  CreateDepartmentDto,
  DepartmentResponseDto,
  UpdateDepartmentDto,
} from './dto/department.dto';
import { OptionsService } from './options.service';

/**
 * Mirrors `system-users.controller.ts`'s helper. Copied rather than exported across modules — it is
 * smaller than its import, and `system-users.policy.ts` is a plain module of pure functions with no
 * Nest DI, so importing it here creates no module wiring and no circular provider reference.
 */
const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
});

/**
 * Admin CRUD for the `Department` registration options. Route prefix: `/api/v1/departments`.
 *
 * Session-guarded (`SUPER_ADMIN`/`ADMIN`; `STAFF` denied), keyed on the auto-increment integer
 * `Department.id`. Same guard stack as `/system-users` — NOT the LINE ID-token guard. Mutations
 * require `x-csrf-token` (enforced by the global CSRF middleware; documented per-route with
 * `@ApiHeader`). `DELETE` is a soft delete. `:id` is parsed with `ParseIntPipe`, so a non-numeric id
 * is a `400` before the service is reached.
 */
@ApiTags('Departments')
@ApiCookieAuth('session')
@Controller('departments')
@UseGuards(SessionGuard, RolesGuard)
export class DepartmentsController {
  constructor(private readonly options: OptionsService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'List department options.',
    description:
      'Non-deleted options only, ordered `name ASC`. System-reserved options are visible to SUPER_ADMIN only.',
  })
  @ApiOkResponse({ description: 'The options.', type: [DepartmentResponseDto] })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'STAFF has no access.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<DepartmentResponseDto[]> {
    return this.options.list('department', {
      includeReserved: mayUseSystemReservedOptions(actorOf(user)),
    });
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Create a department option.',
    description:
      'A name that collides with an ACTIVE option is a 409; a name matching only soft-deleted rows succeeds (names are reusable after soft-delete).',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiCreatedResponse({ description: 'Created.', type: DepartmentResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'STAFF, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'An active option with this name already exists.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  create(@Body() dto: CreateDepartmentDto): Promise<DepartmentResponseDto> {
    return this.options.create('department', dto.name);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Rename a department option.',
    description:
      'An unknown or soft-deleted id is a 404; an active-name collision is a 409. System-reserved options are not editable and answer 404.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Renamed.', type: DepartmentResponseDto })
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
  @ApiConflictResponse({
    description: 'An active option with this name already exists.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDepartmentDto,
  ): Promise<DepartmentResponseDto> {
    return this.options.update('department', id, dto.name);
  }

  // @HttpCode(204) is MANDATORY — Nest defaults DELETE to 200. Empty body (soft delete).
  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Soft-delete a department option.',
    description:
      'Sets `deletedAt`; never a hard delete, so registrations referencing it keep resolving its name. A second DELETE on the same id is a 404. The name becomes reusable. System-reserved options are not deletable and answer 404.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiNoContentResponse({ description: 'Soft-deleted. Empty body.' })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'STAFF, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or already-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.options.softDelete('department', id);
  }
}
