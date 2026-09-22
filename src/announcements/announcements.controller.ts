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
  ApiBadGatewayResponse,
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
import { AnnouncementCodedErrorDto } from './dto/announcement-error.dto';
import { ListAnnouncementsQueryDto } from './dto/announcement-query.dto';
import {
  AnnouncementDto,
  PaginatedAnnouncementsResponseDto,
} from './dto/announcement-response.dto';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement-write.dto';
import { LineBotInfoDto } from './dto/line-bot-info.dto';

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
  'The announcement is `SENT`: sent rows cannot be edited. Also answered when the row stopped being a draft between the read and the conditional write. Nothing is written.';

const AUDIENCE_RULE =
  '`departmentId` is required (non-null) iff `audience` is `DEPARTMENT`, and must be null/omitted for `ALL`; it must reference an ACTIVE department (unknown, soft-deleted, or — for non-SUPER_ADMIN — system-reserved is one indistinguishable 400).';

/** Design §3.3 — published verbatim in the send operation's description (AC-15). */
const SEND_DESCRIPTION = [
  '**Irreversible.** Sends a DRAFT to LINE users as one multicast message — `TEXT`: `title` + blank line + `body`; `FLEX`: one card — and marks it `SENT`. No request body.',
  '',
  'Recipients: LINE users with `access = ALLOWED`, not deleted, with a well-formed LINE id, who have not switched announcements off in their settings; for `DEPARTMENT`, also a live registration in that department. Sent in chunks of up to 500, each with its own `X-Line-Retry-Key`. An empty audience is not an error.',
  '',
  '`sentCount` is the number of recipients LINE **accepted**, not delivered or read.',
  '',
  'Zero eligible recipients → 200, `sentCount` 0, no LINE call — the former 400 "no recipients found" answer was removed in ANNOUNCE-API-5.',
  '',
  'CSRF applies: a request with no session AND no `x-csrf-token` is a 403 (the CSRF middleware runs before the guards).',
  '',
  '| Status | `code` | When | Row after |',
  '|---|---|---|---|',
  '| 200 | — | every chunk accepted | SENT, `sentAt` = now, `sentCount` = targeted |',
  '| 200 | — | zero eligible recipients after every filter | SENT, `sentAt` = now, `sentCount` = 0, **no LINE call** |',
  '| 400 | `ANNOUNCEMENT_BODY_REQUIRED` | `body` is blank | unchanged |',
  '| 400 | `ANNOUNCEMENT_DEPARTMENT_INVALID` | `DEPARTMENT` with a null, missing or soft-deleted department | unchanged |',
  '| 404 | `ANNOUNCEMENT_NOT_FOUND` | unknown, malformed or deleted id | — |',
  '| 409 | `ANNOUNCEMENT_SEND_IN_PROGRESS` | the row is being sent or edited right now | unchanged |',
  '| 409 | `ANNOUNCEMENT_ALREADY_SENT` | the row is `SENT` | unchanged |',
  '| 502 | `ANNOUNCEMENT_PARTIALLY_SENT` (+ `acceptedCount`, `targetedCount`) | at least one chunk accepted, then a failure | **SENT and final**, `sentCount` = `acceptedCount` |',
  '| 502 | `LINE_SEND_FAILED` | first chunk: network, 5xx or timeout after one retry, or another 4xx | DRAFT, untouched |',
  '| 503 | `LINE_NOT_CONFIGURED` | no token, or LINE answered 401/403 | DRAFT, untouched |',
  '| 503 | `LINE_RATE_LIMITED` | LINE answered 429 (rate limit or monthly quota) | DRAFT, untouched |',
  '',
  'A partial send is final: a resend is a 409, and the missed users need a new announcement. After a total failure (DRAFT untouched) a resend is safe within 24 h — the retry keys make LINE answer 409 for any chunk it had in fact accepted. Editing the draft changes the keys.',
].join('\n');

/**
 * `ประกาศและข่าวสาร` — the admin announcements surface, route prefix `/api/v1/announcements`
 * (ANNOUNCE-API-1 persistence + CRUD; ANNOUNCE-API-2 the LINE send and the OA's bot info).
 *
 * ⚠️ ONE ROUTE SENDS: `POST :id/send` (ADMIN / SUPER_ADMIN). POST `/announcements` always creates a
 * `DRAFT` and pushes nothing.
 *
 * DELETE is a soft delete for DRAFT and SENT (ANNOUNCE-API-5); a deleted row is a 404 on every route.
 *
 * ⚠️ ROUTE ORDER IS LOAD-BEARING (D-H): `GET line-bot-info` is declared ABOVE `GET :id`, or
 * `line-bot-info` would be read as an id and answer 404.
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

  // 🔴 MUST STAY ABOVE `@Get(':id')` (D-H) — otherwise `line-bot-info` is captured as an id → 404.
  @Get('line-bot-info')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'The LINE Official Account announcements are sent from.',
    description:
      'One live call to LINE per request — **not cached**, so a fixed token shows at once. Exactly four fields; `pictureUrl` is null when the OA has none. Any LINE failure is a **503 with a `code`, never a 500**: `LINE_NOT_CONFIGURED` when the channel token is missing or rejected (401/403), `LINE_BOT_INFO_UNAVAILABLE` for anything else (429, network, 5xx, timeout).',
  })
  @ApiOkResponse({ description: 'The OA.', type: LineBotInfoDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Password change required (`mustChangePassword`).',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description:
      'LINE is unavailable or not configured — `code` is `LINE_NOT_CONFIGURED` or `LINE_BOT_INFO_UNAVAILABLE`. Never a 500, never cached. (A session-store outage is also a 503, with the house body and no `code`.)',
    type: AnnouncementCodedErrorDto,
  })
  getLineBotInfo(): Promise<LineBotInfoDto> {
    return this.announcements.getLineBotInfo();
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
    description: 'Unknown, malformed or deleted id.',
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
    description: `ALWAYS creates a \`DRAFT\` and pushes nothing to LINE — sending is \`POST /announcements/{id}/send\`. \`status\`, \`sentAt\`, \`sentCount\` and \`createdById\` are not accepted (400); the author is the session user. ${AUDIENCE_RULE}`,
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
    description: 'Unknown, malformed or deleted id.',
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

  // @HttpCode(200) is MANDATORY — Nest defaults POST to 201, and a send creates nothing (design S-7).
  // No `@Body()`: the handler reads no body, so none is validated or needed.
  @Post(':id/send')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Send a draft announcement to LINE users.',
    description: SEND_DESCRIPTION,
  })
  @ApiOkResponse({
    description:
      'Sent — status `SENT`, `sentAt` set, `sentCount` = recipients LINE accepted. `sentCount` 0 when nobody was eligible (no LINE call).',
    type: AnnouncementDto,
  })
  @ApiBadRequestResponse({
    description:
      '`ANNOUNCEMENT_BODY_REQUIRED` or `ANNOUNCEMENT_DEPARTMENT_INVALID`. Nothing is sent or written.',
    type: AnnouncementCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'VIEWER, CSRF failure (a missing or forged `x-csrf-token`, including with no session), or password change required. Nothing is sent or written.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: '`ANNOUNCEMENT_NOT_FOUND` — unknown, malformed or deleted id.',
    type: AnnouncementCodedErrorDto,
  })
  @ApiConflictResponse({
    description:
      '`ANNOUNCEMENT_ALREADY_SENT` — the row is `SENT` (a partial send included); or `ANNOUNCEMENT_SEND_IN_PROGRESS` — another request is sending or editing this row right now. Nothing is sent.',
    type: AnnouncementCodedErrorDto,
  })
  @ApiBadGatewayResponse({
    description:
      '`ANNOUNCEMENT_PARTIALLY_SENT` (with `acceptedCount`, `targetedCount`) — the row IS `SENT` and final, `sentCount` = `acceptedCount`; or `LINE_SEND_FAILED` — LINE accepted nobody, the row stays DRAFT and a resend within 24 h is safe.',
    type: AnnouncementCodedErrorDto,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`LINE_NOT_CONFIGURED` (no token, or LINE answered 401/403) or `LINE_RATE_LIMITED` (429 — rate limit or monthly quota). The row stays DRAFT. (A session-store outage is also a 503, with the house body and no `code`.)',
    type: AnnouncementCodedErrorDto,
  })
  send(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AnnouncementDto> {
    return this.announcements.send(id, user.id);
  }

  // @HttpCode(204) is MANDATORY — Nest defaults DELETE to 200 (design S-7, house convention).
  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Delete an announcement (soft delete).',
    description:
      'A SOFT delete of a DRAFT or a SENT announcement: the row is kept for audit with `deletedAt` set and disappears from every route (list, counts, get, edit, send → 404). Irreversible through the API. Fails fast with 409 `ANNOUNCEMENT_SEND_IN_PROGRESS` if the row is being sent or edited at that moment; retry after the send completes. A second DELETE is a 404.',
  })
  @ApiNoContentResponse({ description: 'Soft-deleted. Empty body.' })
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
    description:
      '`ANNOUNCEMENT_NOT_FOUND`: unknown, malformed or already deleted id.',
    type: AnnouncementCodedErrorDto,
  })
  @ApiConflictResponse({
    description:
      '`ANNOUNCEMENT_SEND_IN_PROGRESS`: the row is being sent or edited right now. Nothing is deleted.',
    type: AnnouncementCodedErrorDto,
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
