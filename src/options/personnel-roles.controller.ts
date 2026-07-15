import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import {
  CreatePersonnelRoleDto,
  PersonnelRoleResponseDto,
  UpdatePersonnelRoleDto,
} from './dto/personnel-role.dto';
import { OptionsService } from './options.service';

/**
 * Admin CRUD for the `PersonnelRole` registration options. Route prefix: `/api/v1/personnel-roles`.
 *
 * `PersonnelRole` is the LINE end-user's self-declared role (Teacher, Support Staff, …) — admin-
 * curated DATA. It is NOT `SystemRole` (SUPER_ADMIN/ADMIN/STAFF), the back-office RBAC enum: they
 * share no table, enum, or endpoint. Creating a PersonnelRole named e.g. "ADMIN" grants no privilege.
 *
 * Session-guarded (`SUPER_ADMIN`/`ADMIN`; `STAFF` denied), keyed on the cuid `PersonnelRole.id`.
 * Mutations require `x-csrf-token`. `DELETE` is a soft delete.
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
    description: 'Non-deleted options only, ordered `name ASC`.',
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
  list(): Promise<PersonnelRoleResponseDto[]> {
    return this.options.list('personnelRole');
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
      'An unknown or soft-deleted id is a 404; an active-name collision is a 409.',
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
    @Param('id') id: string,
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
      'Sets `deletedAt`; never a hard delete, so registrations referencing it keep resolving its name. A second DELETE on the same id is a 404. The name becomes reusable.',
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
  remove(@Param('id') id: string): Promise<void> {
    return this.options.softDelete('personnelRole', id);
  }
}
