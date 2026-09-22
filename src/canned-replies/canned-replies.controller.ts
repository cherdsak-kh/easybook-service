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
  ApiBadRequestResponse,
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
import { CannedRepliesService } from './canned-replies.service';
import { CannedReplyCodedErrorDto } from './dto/canned-reply-error.dto';
import { CannedReplyDto } from './dto/canned-reply-response.dto';
import {
  CreateCannedReplyDto,
  UpdateCannedReplyDto,
} from './dto/canned-reply-write.dto';

const NO_SESSION = { description: 'No session.', type: ErrorResponseDto };
const SESSION_STORE_DOWN = {
  description: 'Session store unavailable.',
  type: ErrorResponseDto,
};
const WRITE_FORBIDDEN = {
  description:
    'VIEWER, CSRF failure (a missing or forged `x-csrf-token`, including with no session), or password change required. Nothing is written.',
  type: ErrorResponseDto,
};
const NOT_FOUND = {
  description:
    '`CANNED_REPLY_NOT_FOUND` — unknown or malformed id (including one already deleted).',
  type: CannedReplyCodedErrorDto,
};

/**
 * `ข้อความตอบกลับด่วน` — admin-curated snippets staff copy into the LINE OA chat console, route prefix
 * `/api/v1/canned-replies` (ANNOUNCE-API-5, plan D-3…D-5).
 *
 * ⚠️ `VIEWER` READS AND CHANGES NOTHING — the split every admin surface uses. `@Roles` per method is
 * the boundary; hiding a button in React is UX.
 *
 * ⚠️ CSRF APPLIES TO THE THREE WRITES through the GLOBAL middleware, and nothing here is (or may be) in
 * `CSRF_EXEMPT_PATHS` / `CSRF_EXEMPT_PATTERNS`. Because the CSRF middleware runs before the route
 * guards, a write with no session AND no token answers 403 (CSRF), not 401.
 *
 * No `ParseIntPipe` and no cuid pipe: an unknown or malformed id is a 404 (announcements precedent).
 * Not throttled and not cached, like every other staff route.
 */
@ApiTags('Canned replies')
@ApiCookieAuth('session')
@Controller('canned-replies')
@UseGuards(SessionGuard, RolesGuard)
export class CannedRepliesController {
  constructor(private readonly cannedReplies: CannedRepliesService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'List canned replies.',
    description:
      'Every canned reply (at most 5) as a PLAIN ARRAY, ordered `sortOrder ASC`, ties broken on `createdAt ASC` then `id ASC`. `[]` when there are none. No pagination and no query parameters.',
  })
  @ApiOkResponse({ description: 'The replies.', type: [CannedReplyDto] })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse({
    description: 'Password change required (`mustChangePassword`).',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  list(): Promise<CannedReplyDto[]> {
    return this.cannedReplies.list();
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Create a canned reply.',
    description:
      'At most 5 canned replies exist; a POST at 5 is a 400 `CANNED_REPLIES_LIMIT_EXCEEDED` and writes nothing. Two concurrent POSTs at 4 serialise: exactly one succeeds. An omitted `sortOrder` puts the reply at the bottom (current maximum + 1, capped at 9999; 0 on an empty table).',
  })
  @ApiCreatedResponse({ description: 'Created.', type: CannedReplyDto })
  @ApiBadRequestResponse({
    description:
      '`CANNED_REPLIES_LIMIT_EXCEEDED` (coded body, Thai `message`). A validation failure — blank or over-length `title`/`text`, a `sortOrder` outside 0–9999 or not an integer (a JSON string included), an unknown key — is the house body with a `string[]` `message` and NO `code`. Nothing is written.',
    type: CannedReplyCodedErrorDto,
  })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  create(
    @Body() dto: CreateCannedReplyDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<CannedReplyDto> {
    return this.cannedReplies.create(dto, user.id);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Edit a canned reply.',
    description:
      'Any subset of `title`, `text`, `sortOrder` (at least one). An empty body `{}` is a 400 `CANNED_REPLY_UPDATE_EMPTY`; `null` for any field is a 400. `updatedAt` advances. Answers with the updated record.',
  })
  @ApiOkResponse({ description: 'Saved.', type: CannedReplyDto })
  @ApiBadRequestResponse({
    description:
      '`CANNED_REPLY_UPDATE_EMPTY` (coded body). A validation failure is the house body with a `string[]` `message` and NO `code`. Nothing is written.',
    type: CannedReplyCodedErrorDto,
  })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCannedReplyDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<CannedReplyDto> {
    return this.cannedReplies.update(id, dto, user.id);
  }

  // @HttpCode(204) is MANDATORY — Nest defaults DELETE to 200 (house convention).
  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Delete a canned reply.',
    description:
      'A HARD delete — there is no restore. A second DELETE on the same id is a 404. Deleting every reply is allowed; nothing re-seeds the defaults.',
  })
  @ApiNoContentResponse({ description: 'Deleted. Empty body.' })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<void> {
    return this.cannedReplies.remove(id, user.id);
  }
}
