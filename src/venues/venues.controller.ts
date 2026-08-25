import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { SystemRole } from '@prisma/client';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
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
import { MulterErrorTo400Filter } from '../common/filters/multer-error.filter';
import {
  CloseVenueDto,
  CreateVenueDto,
  DiscardVenuePhotoDto,
  ListVenuesQueryDto,
  UpdateVenueDto,
  VenuePhotoUploadResponseDto,
  VenueResponseDto,
} from './dto/venue.dto';
import { VenuePhotoUploadService } from './venue-photo-upload.service';
import {
  VENUE_PHOTOS_MAX,
  VENUE_PHOTO_MULTER_SIZE_LIMIT,
  VENUE_PHOTO_REQUIRED,
  VENUE_PHOTO_TOO_LARGE,
} from './venues.constants';
import { VenuesService } from './venues.service';

/**
 * `สถานที่จัดกิจกรรม` — route prefix `/api/v1/venues`.
 *
 * ⚠️ `VIEWER` MAY READ, AND MAY DO NOTHING ELSE. That split is the same one `/system-users` and
 * `/line-users` settled on and the opposite of the four curated tables, where `VIEWER` is denied
 * outright: `การตั้งค่าระบบ` is an action surface with no read-only value, while a venue list is
 * exactly the kind of thing a supervisor is expected to look at. It matches `VIEWER_DENY` in the
 * app's `use-acl.ts`, which does not list `สถานที่จัดกิจกรรม`.
 *
 * ⚠️ HIDING A BUTTON IS UX, NEVER THE BOUNDARY. The dialog opens read-only for a VIEWER and every
 * control in it is `disabled`; none of that stops anything. `@Roles` on the write verbs below is what
 * does, and a route that forgets to list a role fails CLOSED.
 *
 * ── Route ORDER matters here ──
 * `photos` is a literal segment that would otherwise be captured by `:id`. Nest matches in
 * declaration order, so the two `/venues/photos` routes MUST stay above `PATCH`/`DELETE :id`.
 * A cuid never spells "photos", so the collision is not reachable today — but the ordering is what
 * keeps that a property of the router rather than of the id format.
 */
@ApiTags('Venues')
@ApiCookieAuth('session')
@Controller('venues')
@UseGuards(SessionGuard, RolesGuard)
export class VenuesController {
  constructor(
    private readonly venues: VenuesService,
    private readonly photos: VenuePhotoUploadService,
  ) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'List venues.',
    description:
      'Non-deleted venues only, ordered `name ASC`. Returns EVERYTHING — there is no pagination; the screen states a count. `q` matches the name or the location. The reserved tombstone category id is accepted by `venueTypeId` so orphaned venues can be found (unlike on create/update, which refuse it).',
  })
  @ApiOkResponse({ description: 'The venues.', type: [VenueResponseDto] })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(@Query() query: ListVenuesQueryDto): Promise<VenueResponseDto[]> {
    return this.venues.list(query);
  }

  // ── The UNBOUND photo pair. Declared before `:id` — see the class note on route order. ──────────

  @Post('photos')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  // memoryStorage: the object is <= 5 MiB and goes straight to R2; nothing should ever hit local
  // disk. `limits.fileSize` aborts the stream AT the limit, so an oversized upload is never fully
  // buffered. `limits.files: 1` rejects multi-part floods.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      // `VENUE_PHOTO_MAX_BYTES + 1` — busboy's limit is EXCLUSIVE. See the constant's doc comment;
      // passing 5 MiB here would reject a file of exactly 5 MiB (AC-S9).
      limits: { fileSize: VENUE_PHOTO_MULTER_SIZE_LIMIT, files: 1 },
    }),
  )
  // An INSTANCE carrying THIS endpoint's size message — the avatar route passes its own 2 MB one.
  @UseFilters(new MulterErrorTo400Filter(VENUE_PHOTO_TOO_LARGE))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG, PNG or WEBP. Max 5 MB.',
        },
      },
    },
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Upload one venue photo and get its URL back.',
    description:
      'Multipart, one part named `file`. NO venue id: photos are picked inside the CREATE dialog, before a venue exists. The object is stored UNBOUND and becomes part of a venue only when its URL appears in `photoUrls` on a create/update. If the operator cancels instead, call DELETE /venues/photos to discard it. The declared MIME is a first filter only — the real control is a MAGIC-BYTE sniff, and the stored ContentType and key extension come from the SNIFFED type, never from the filename. The CSRF token is a HEADER and works fine with multipart.',
  })
  @ApiOkResponse({ description: 'Stored.', type: VenuePhotoUploadResponseDto })
  @ApiBadRequestResponse({
    description:
      'No file, wrong field name, unsupported/mismatched image type, or larger than 5 MB.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'The object store rejected the upload or was unreachable.',
    type: ErrorResponseDto,
  })
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<VenuePhotoUploadResponseDto> {
    if (!file) throw new BadRequestException(VENUE_PHOTO_REQUIRED);
    return this.photos.upload(file);
  }

  @Delete('photos')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Discard an uploaded photo that was never attached to a venue.',
    description:
      'For the cancel path: the dialog uploaded an object and the operator backed out. REFUSES any URL a venue still references (409) — removing a photo FROM a venue is a PATCH of `photoUrls`, which deletes the dropped objects itself. A URL outside this deployment’s bucket is a 400.',
  })
  @ApiNoContentResponse({ description: 'Discarded. Empty body.' })
  @ApiBadRequestResponse({
    description: 'Not a URL in this deployment’s venue photo bucket.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'The photo belongs to a venue.',
    type: ErrorResponseDto,
  })
  discardPhoto(@Body() dto: DiscardVenuePhotoDto): Promise<void> {
    return this.photos.discard(dto.url);
  }

  // ── The venue itself ────────────────────────────────────────────────────────────────────────────

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Create a venue.',
    description: `Always created OPEN — the form has no switch in create mode and neither has this body. A name colliding with an ACTIVE venue is a 409; a name matching only soft-deleted rows succeeds. \`venueTypeId\` must be an ACTIVE, non-reserved category, and every \`amenityIds\` entry an ACTIVE amenity — otherwise the SAME 400 an unknown id gets, never a 403. \`photoUrls\` is ordered, index 0 is the cover, max ${VENUE_PHOTOS_MAX}, and every entry must already have been uploaded via POST /venues/photos.`,
  })
  @ApiCreatedResponse({ description: 'Created.', type: VenueResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or the category/an amenity does not exist or is not assignable.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'An active venue with this name already exists.',
    type: ErrorResponseDto,
  })
  create(@Body() dto: CreateVenueDto): Promise<VenueResponseDto> {
    return this.venues.create(dto);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Update a venue.',
    description:
      'Every field is optional. An omitted `amenityIds`/`photoUrls` means UNCHANGED; clearing is `[]`. Both are REPLACED, never merged. `isOpen` and `closedReason` are absent from the body on purpose — sending either is a 400, because closing needs a reason and is its own transition (POST /:id/close).',
  })
  @ApiOkResponse({ description: 'Updated.', type: VenueResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed (including any attempt to send `isOpen`), or the category/an amenity is not assignable.',
    type: ErrorResponseDto,
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
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'An active venue with this name already exists.',
    type: ErrorResponseDto,
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateVenueDto,
  ): Promise<VenueResponseDto> {
    return this.venues.update(id, dto);
  }

  @Post(':id/close')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'ปิดชั่วคราว — stop accepting new booking requests.',
    description:
      'NOT a delete: the venue stays visible to end users. The reason is REQUIRED (400 without one) because it is shown to the people it affects — on the venue card, and in LINE. Closing an already-closed venue is a 409 rather than a silent no-op: it would replace the reason people are reading, and the screen only offers this on an open venue.',
  })
  @ApiOkResponse({ description: 'Closed.', type: VenueResponseDto })
  @ApiBadRequestResponse({
    description: 'Missing or blank reason.',
    type: ErrorResponseDto,
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
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'The venue is already closed.',
    type: ErrorResponseDto,
  })
  close(
    @Param('id') id: string,
    @Body() dto: CloseVenueDto,
  ): Promise<VenueResponseDto> {
    return this.venues.close(id, dto.reason);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'เปิดให้จอง — accept booking requests again.',
    description:
      'Clears `closedReason` to NULL, which the confirm dialog promises explicitly. Reopening an already-open venue is a 409.',
  })
  @ApiOkResponse({ description: 'Reopened.', type: VenueResponseDto })
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
    description: 'The venue is already open.',
    type: ErrorResponseDto,
  })
  reopen(@Param('id') id: string): Promise<VenueResponseDto> {
    return this.venues.reopen(id);
  }

  // @HttpCode(204) is MANDATORY — Nest defaults DELETE to 200. Empty body (soft delete).
  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Soft-delete a venue.',
    description:
      'Sets `deletedAt`; never a hard delete — a future `Booking.venueId` must keep resolving a name, which is what the confirm dialog’s "ประวัติคำขอจองยังอยู่ครบ" promises. The photo rows and their objects are kept with it; a soft-deleted venue is invisible to every route, so nothing renders them. A second DELETE on the same id is a 404.',
  })
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
    description: 'Unknown or already-deleted id.',
    type: ErrorResponseDto,
  })
  remove(@Param('id') id: string): Promise<void> {
    return this.venues.softDelete(id);
  }
}
