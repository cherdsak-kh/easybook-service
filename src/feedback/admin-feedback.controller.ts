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
  ApiConflictResponse,
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
import { AdminFeedbackService } from './admin-feedback.service';
import { ListFeedbackQueryDto } from './dto/admin-feedback-query.dto';
import {
  AdminFeedbackDetailDto,
  PaginatedFeedbackResponseDto,
} from './dto/admin-feedback-response.dto';
import { UpdateFeedbackDto } from './dto/admin-feedback-write.dto';

/**
 * `ข้อเสนอแนะ/แจ้งปัญหา` — the admin triage console, route prefix `/api/v1/feedback` (ADMIN-FEEDBACK-1).
 *
 * ⚠️ NAMED `AdminFeedbackController`, NEVER `FeedbackController` (design C-5): that name is the LIFF
 * controller's, and Swagger's default operationId (`<Class>_<method>`) would collide.
 *
 * ⚠️ `VIEWER` MAY READ THE WHOLE RECORD AND MAY CHANGE NOTHING — the split every admin surface uses.
 * `@Roles` on the PATCH is the boundary; hiding the form in React is UX (D-9, E-7).
 *
 * ⚠️ CSRF APPLIES TO THE PATCH, and nothing here is in `CSRF_EXEMPT_PATHS` / `CSRF_EXEMPT_PATTERNS`,
 * nor may be: this surface stands on an `express-session` cookie. The LIFF routes' exemptions are
 * the literal `/line-users/feedback…` paths — a different first segment, so they cannot cover these.
 * The GETs are exempt by METHOD (`ignoredMethods`), not by path.
 *
 * ── ROUTE COLLISIONS ──
 * None: the LIFF routes live under `/line-users/feedback…`, and `GET feedback/:id` has no literal
 * sibling here. Not throttled, like every other staff route.
 */
@ApiTags('Feedback')
@ApiCookieAuth('session')
@Controller('feedback')
@UseGuards(SessionGuard, RolesGuard)
export class AdminFeedbackController {
  constructor(private readonly feedback: AdminFeedbackService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'List feedback and issue reports — the triage queue.',
    description:
      'Filtered and paginated by the server, newest first (ties broken on `code`, so the order is total). `type`, `status`, `venueId` and `q` combine with AND; `venueId=general` selects reports with no venue. `meta.total` is the FILTERED total. `counts` is GLOBAL — computed over the whole table and unaffected by any filter or page.',
  })
  @ApiOkResponse({
    description: 'The page.',
    type: PaginatedFeedbackResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid query — `limit` outside 10/20/50, `page` < 1, an unknown `type`/`status`, `q` over 100 characters, or an unrecognised parameter.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @Query() query: ListFeedbackQueryDto,
  ): Promise<PaginatedFeedbackResponseDto> {
    return this.feedback.list(query);
  }

  @Get(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'One report, with its photos and triage log.',
    description:
      'Addressed by cuid only — no `code` lookup. Adds `photos` (public URLs, stored order) and `logs` (`createdAt` ASC; `[]` for an untouched report) to the list shape. Reporter fields are all nullable: a missing registration is a 200 with nulls, never a 500. The LINE `U…` subject is never included.',
  })
  @ApiOkResponse({ description: 'The report.', type: AdminFeedbackDetailDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
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
  get(@Param('id') id: string): Promise<AdminFeedbackDetailDto> {
    return this.feedback.getDetail(id);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary:
      'Record a staff action — a status change, an internal note, or both.',
    description:
      'Every accepted save appends exactly ONE log entry whose `status` is the RESULTING status, authored by the session user (never the body). A status-only change logs `note: null`; a note-only save (status absent or unchanged) logs the current status and leaves the report untouched. Any state may move to any of `PENDING` / `IN_PROGRESS` / `RESOLVED` — there is no transition policy; `DISMISSED` is refused. The status write and the log insert are one transaction under a row lock. The note is internal and is never sent to the reporter. Answers with the updated detail.',
  })
  @ApiOkResponse({
    description:
      'Saved — the detail, already showing the new status and the appended log.',
    type: AdminFeedbackDetailDto,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed (an unknown key such as `authorId`, `status: DISMISSED` or `null`, a note over 500 characters after trimming, a non-string note) — or, as a single string, `Provide a new status or a non-blank note.` (neither was sent) / `No change: the status is unchanged and the note is blank.`. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or malformed id. Nothing is written.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'A serialization failure or deadlock on the transaction (practically unreachable under the row lock). Retryable.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminFeedbackDetailDto> {
    return this.feedback.update(id, dto, { id: user.id });
  }
}
