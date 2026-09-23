import {
  Body,
  Controller,
  Delete,
  Get,
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
import { AmenitiesService } from './amenities.service';
import {
  AmenityResponseDto,
  CreateAmenityDto,
  DeleteAmenityResponseDto,
  UpdateAmenityDto,
} from './dto/amenity.dto';

/**
 * Admin CRUD for `Amenity` (อุปกรณ์ที่ให้บริการ). Route prefix: `/api/v1/amenities`.
 *
 * ⚠️ TWO VISIBLE DIFFERENCES FROM THE OTHER THREE CURATED-TABLE CONTROLLERS, both consequences of
 * this table having no reserved rows:
 *
 *   · `list` takes no `@CurrentUser()` and calls no policy. There is no `includeReserved` decision
 *     to make, so there is no `actorOf` helper and no `mayUseSystemReservedOptions` import here.
 *     A SUPER_ADMIN and an ADMIN receive byte-identical bodies.
 *   · `DELETE` answers **200 with a count**, not 204 — see `DeleteAmenityResponseDto`.
 *
 * Everything else is the shared contract: `VIEWER` denied, `x-csrf-token` on mutations, soft delete,
 * `ParseIntPipe` on `:id`.
 */
@ApiTags('Amenities')
@ApiCookieAuth('session')
@Controller('amenities')
@UseGuards(SessionGuard, RolesGuard)
export class AmenitiesController {
  constructor(private readonly amenities: AmenitiesService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'List amenity options.',
    description:
      'Non-deleted options only, ordered `name ASC`. Identical for every role — this table has no reserved rows. May legitimately be empty: amenities are optional on the venue form, and nothing is seeded.',
  })
  @ApiOkResponse({ description: 'The options.', type: [AmenityResponseDto] })
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
  list(): Promise<AmenityResponseDto[]> {
    return this.amenities.list();
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Create an amenity option.',
    description:
      'A name that collides with an ACTIVE option is a 409; a name matching only soft-deleted rows succeeds.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiCreatedResponse({ description: 'Created.', type: AmenityResponseDto })
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
  create(@Body() dto: CreateAmenityDto): Promise<AmenityResponseDto> {
    return this.amenities.create(dto.name);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Rename an amenity option.',
    description:
      'An unknown or soft-deleted id is a 404; an active-name collision is a 409. Every row on this table is editable — there are no reserved rows to refuse.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Renamed.', type: AmenityResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
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
    @Body() dto: UpdateAmenityDto,
  ): Promise<AmenityResponseDto> {
    return this.amenities.update(id, dto.name);
  }

  // NOT @HttpCode(204). This delete reports how many venues lost the amenity, because the confirm
  // dialog quoted that number before the click and another operator may have changed it since.
  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Soft-delete an amenity option and release its ticks.',
    description:
      'Sets `deletedAt` on the amenity and removes it from every venue that provided it, in one transaction. The venues themselves are untouched and remain bookable. Returns how many venues lost the amenity. A second DELETE on the same id is a 404.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({
    description: 'Soft-deleted; reports how many venues lost the amenity.',
    type: DeleteAmenityResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
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
  remove(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DeleteAmenityResponseDto> {
    return this.amenities.softDelete(id);
  }
}
