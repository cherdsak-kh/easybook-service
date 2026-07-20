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
  CreatePersonnelRoleDto,
  PersonnelRoleResponseDto,
  UpdatePersonnelRoleDto,
} from './dto/personnel-role.dto';
import { OptionsService } from './options.service';

/** Mirrors `system-users.controller.ts`'s helper — see `departments.controller.ts` for why it is copied. */
const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
});

/**
 * Admin CRUD for the `PersonnelRole` registration options. Route prefix: `/api/v1/personnel-roles`.
 *
 * `PersonnelRole` is the LINE end-user's self-declared role (Teacher, Support Staff, …) — admin-
 * curated DATA. It is NOT `SystemRole` (SUPER_ADMIN/ADMIN/STAFF), the back-office RBAC enum: they
 * share no table, enum, or endpoint. Creating a PersonnelRole named e.g. "ADMIN" grants no privilege.
 *
 * Session-guarded (`SUPER_ADMIN`/`ADMIN`; `STAFF` denied), keyed on the auto-increment integer
 * `PersonnelRole.id`. Mutations require `x-csrf-token`. `DELETE` is a soft delete. `:id` is parsed
 * with `ParseIntPipe`, so a non-numeric id is a `400` before the service is reached.
 */
@ApiTags('Personnel Roles')
@ApiCookieAuth('session')
@Controller('personnel-roles')
@UseGuards(SessionGuard, RolesGuard)
export class PersonnelRolesController {
  constructor(private readonly options: OptionsService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'List personnel-role options.',
    description:
      'Non-deleted options only, ordered `name ASC`. System-reserved options are visible to SUPER_ADMIN only.',
  })
  @ApiOkResponse({
    description: 'The options.',
    type: [PersonnelRoleResponseDto],
  })
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
  ): Promise<PersonnelRoleResponseDto[]> {
    return this.options.list('personnelRole', {
      includeReserved: mayUseSystemReservedOptions(actorOf(user)),
    });
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Create a personnel-role option.',
    description:
      'A name that collides with an ACTIVE option is a 409; a name matching only soft-deleted rows succeeds (names are reusable after soft-delete).',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiCreatedResponse({
    description: 'Created.',
    type: PersonnelRoleResponseDto,
  })
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
  create(
    @Body() dto: CreatePersonnelRoleDto,
  ): Promise<PersonnelRoleResponseDto> {
    return this.options.create('personnelRole', dto.name);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Rename a personnel-role option.',
    description:
      'An unknown or soft-deleted id is a 404; an active-name collision is a 409. System-reserved options are not editable and answer 404.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Renamed.', type: PersonnelRoleResponseDto })
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
    @Body() dto: UpdatePersonnelRoleDto,
  ): Promise<PersonnelRoleResponseDto> {
    return this.options.update('personnelRole', id, dto.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Soft-delete a personnel-role option.',
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
    return this.options.softDelete('personnelRole', id);
  }
}
