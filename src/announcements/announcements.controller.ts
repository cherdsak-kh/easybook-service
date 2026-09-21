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
  AnnouncementsService,
  type AnnouncementActor,
} from './announcements.service';
import { ListAnnouncementsQueryDto } from './dto/announcement-query.dto';
import {
  AnnouncementDto,
  PaginatedAnnouncementsResponseDto,
} from './dto/announcement-response.dto';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement-write.dto';

/**
 * Mirrors `departments.controller.ts`'s helper — copied rather than exported across modules; it is
 * smaller than its import, and `system-users.policy.ts` is pure functions with no Nest DI.
 */
const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
  createdById: user.createdBy?.id ?? null,
});

/**
 * The service's view of the caller: the id it records (D-5) and the reserved-department capability,
 * decided HERE by the one policy function so the service only ever sees a boolean (design S-5).
 */
const announcementActorOf = (
  user: AuthenticatedSystemUser,
): AnnouncementActor => ({
  id: user.id,
  includeReserved: mayUseSystemReservedOptions(actorOf(user)),
});

const SENT_IMMUTABLE_DESCRIPTION =
  'The announcement is `SENT` — sent rows are immutable (D-2). Also answered when the row stopped being a draft between the read and the conditional write. Nothing is written.';

const AUDIENCE_RULE =
  '`departmentId` is required (non-null) iff `audience` is `DEPARTMENT`, and must be null/omitted for `ALL`; it must reference an ACTIVE department (unknown, soft-deleted, or — for non-SUPER_ADMIN — system-reserved is one indistinguishable 400).';

/**
 * `ประกาศและข่าวสาร` — the admin announcements surface, route prefix `/api/v1/announcements`
 * (ANNOUNCE-API-1, phase 1: persistence + CRUD).
 *
 * ⚠️ NOTHING HERE SENDS ANYTHING (D-1). There is no send / publish route and no LINE push; POST always
 * creates a `DRAFT`. `SENT` is unreachable through the API in phase 1 and exists so the immutability
 * guards (PATCH/DELETE → 409) are built and tested now.
 *
 * ⚠️ `VIEWER` READS AND CHANGES NOTHING — the split every admin surface uses. `@Roles` per method is
 * the boundary; hiding a button in React is UX.
 *
 * ⚠️ CSRF APPLIES TO THE THREE WRITES, and nothing here is (or may be) in `CSRF_EXEMPT_PATHS` /
 * `CSRF_EXEMPT_PATTERNS`: this surface stands on an `express-session` cookie. The GETs are exempt by
 * METHOD. Because the CSRF middleware runs before the route guards, a write with no session AND no
 * token answers 403 (CSRF), not 401.
 *
 * Not throttled, like every other staff route.
 */
@ApiTags('Announcements')
@ApiCookieAuth('session')
@Controller('announcements')
@UseGuards(SessionGuard, RolesGuard)
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'List announcements, newest first.',
    description:
      'Paginated by the server; ordered `createdAt DESC`, ties broken on `id DESC`. `status` (`all|sent|draft`) and `q` (case-insensitive substring over `title` only) combine with AND. `meta.total` is the FILTERED total. A page past the end is `data: []` with a correct `meta`.',
  })
  @ApiOkResponse({
    description: 'The page.',
    type: PaginatedAnnouncementsResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid query — `limit` outside 10/20/50, `page` < 1, an unknown `status` (the filter is lowercase), `q` over 100 characters, or an unrecognised parameter.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Password change required (`mustChangePassword`).',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @Query() query: ListAnnouncementsQueryDto,
  ): Promise<PaginatedAnnouncementsResponseDto> {
    return this.announcements.list(query);
  }

  @Get(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'One announcement.',
    description:
      'Addressed by cuid. The same item shape as a list row. `department` and `createdBy` resolve as history — a soft-deleted department or staff member still shows.',
  })
  @ApiOkResponse({ description: 'The announcement.', type: AnnouncementDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Password change required (`mustChangePassword`).',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or malformed id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  get(@Param('id') id: string): Promise<AnnouncementDto> {
    return this.announcements.get(id);
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Create a draft announcement.',
    description: `ALWAYS creates a \`DRAFT\` — there is no send route in phase 1 and nothing is pushed to LINE. \`status\`, \`sentAt\`, \`sentCount\` and \`createdById\` are not accepted (400); the author is the session user. ${AUDIENCE_RULE}`,
  })
  @ApiCreatedResponse({
    description: 'Created — status `DRAFT`.',
    type: AnnouncementDto,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed (blank title, title over 100 or body over 1000 characters after trimming, a bad `format`/`audience`, a non-integer `departmentId`, an unknown key such as `status`) — or, as a single string, an audience/department rule or an invalid department. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'VIEWER, CSRF failure, or password change required. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  create(
    @Body() dto: CreateAnnouncementDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AnnouncementDto> {
    return this.announcements.create(dto, announcementActorOf(user));
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Edit a draft announcement.',
    description: `DRAFT only — a \`SENT\` row is immutable (409). An empty body \`{}\` is a 400 (\`Provide at least one field to update.\`). The audience rule is checked on the MERGED state (stored + patch): \`{ "audience": "DEPARTMENT" }\` alone keeps the stored department, \`{ "audience": "ALL" }\` alone clears it, and a patch of a DEPARTMENT draft re-validates the stored department. ${AUDIENCE_RULE} Answers with the updated record.`,
  })
  @ApiOkResponse({ description: 'Saved.', type: AnnouncementDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed (blank or `null` title, over-length title/body, bad enum, a non-integer `departmentId`, an unknown key) — or, as a single string, an empty body, an audience/department rule, or an invalid department. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'VIEWER, CSRF failure, or password change required. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or malformed id.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: SENT_IMMUTABLE_DESCRIPTION,
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AnnouncementDto> {
    return this.announcements.update(id, dto, announcementActorOf(user));
  }

  // @HttpCode(204) is MANDATORY — Nest defaults DELETE to 200 (design S-7, house convention).
  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Delete a draft announcement.',
    description:
      'A HARD delete, DRAFT only. A `SENT` row cannot be deleted (409). A second DELETE on the same id is a 404.',
  })
  @ApiNoContentResponse({ description: 'Deleted. Empty body.' })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'VIEWER, CSRF failure, or password change required. Nothing is deleted.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or malformed id.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: SENT_IMMUTABLE_DESCRIPTION,
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<void> {
    return this.announcements.remove(id, user.id);
  }
}
