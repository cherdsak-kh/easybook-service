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
  CreateVenueTypeDto,
  UpdateVenueTypeDto,
  VenueTypeResponseDto,
} from './dto/venue-type.dto';
import { VenueTypesService } from './venue-types.service';

/** Mirrors the helper in `departments.controller.ts` — see the note there on why it is copied. */
const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
  createdById: user.createdBy?.id ?? null,
});

/**
 * Admin CRUD for `VenueType` (ประเภทสถานที่). Route prefix: `/api/v1/venue-types`.
 *
 * Guard stack, status codes and reserved-row semantics are the same as `/departments` — deliberately
 * so, because they are a contract the four curated-table screens share, not an implementation
 * detail. `VIEWER` is denied; mutations need `x-csrf-token`; `DELETE` is a soft delete; `:id` goes
 * through `ParseIntPipe`, so a non-numeric id is a 400 before the service is reached.
 */
@ApiTags('Venue types')
@ApiCookieAuth('session')
@Controller('venue-types')
@UseGuards(SessionGuard, RolesGuard)
export class VenueTypesController {
  constructor(private readonly venueTypes: VenueTypesService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'List venue type options.',
    description:
      'Non-deleted options only, ordered `name ASC`. The reserved tombstone row is visible to SUPER_ADMIN only.',
  })
  @ApiOkResponse({ description: 'The options.', type: [VenueTypeResponseDto] })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER has no access.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<VenueTypeResponseDto[]> {
    return this.venueTypes.list({
      includeReserved: mayUseSystemReservedOptions(actorOf(user)),
    });
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Create a venue type option.',
    description:
      'A name that collides with an ACTIVE option is a 409; a name matching only soft-deleted rows succeeds (names are reusable after soft-delete).',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiCreatedResponse({ description: 'Created.', type: VenueTypeResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
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
  create(@Body() dto: CreateVenueTypeDto): Promise<VenueTypeResponseDto> {
    return this.venueTypes.create(dto.name);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Rename a venue type option.',
    description:
      'An unknown or soft-deleted id is a 404; an active-name collision is a 409. The reserved tombstone row is not editable and answers 404 for every role, SUPER_ADMIN included.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Renamed.', type: VenueTypeResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown, soft-deleted, or reserved id.',
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
    @Body() dto: UpdateVenueTypeDto,
  ): Promise<VenueTypeResponseDto> {
    return this.venueTypes.update(id, dto.name);
  }

  // @HttpCode(204) is MANDATORY — Nest defaults DELETE to 200. Empty body (soft delete).
  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Soft-delete a venue type option.',
    description:
      'Sets `deletedAt`; never a hard delete. Venues filed under it are re-pointed to the reserved tombstone row in the same transaction. A second DELETE on the same id is a 404, as is the reserved row itself. Answers 500 if the tombstone row has never been seeded — run `npm run venue-types:seed`.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiNoContentResponse({ description: 'Soft-deleted. Empty body.' })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown, already-deleted, or reserved id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.venueTypes.softDelete(id);
  }
}
