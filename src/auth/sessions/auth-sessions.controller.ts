import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import type { Request } from 'express';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import type { AuthenticatedSystemUser } from '../auth.types';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SessionGuard } from '../guards/session.guard';
import {
  ListLoginHistoryQueryDto,
  LoginHistoryPageDto,
} from './dto/login-history.dto';
import {
  RevokeSessionsResponseDto,
  SessionListResponseDto,
} from './dto/session.dto';
import { LoginLogService } from './login-log.service';
import { SessionTrackerService } from './session-tracker.service';
import {
  SessionsService,
  type CurrentSessionContext,
} from './sessions.service';

const contextOf = (
  req: Request,
  user: AuthenticatedSystemUser,
): CurrentSessionContext => ({
  userId: user.id,
  sid: req.sessionID,
  session: req.session,
});

/**
 * The signed-in user's OWN sessions and login history (LOGIN-SESSIONS-1, E1–E4). Route prefix:
 * `/api/v1/auth/system`. Every role may use it; identity comes from the session only, never from input.
 *
 * **STANDING RULE: literal routes first. `DELETE sessions/others` MUST stay declared above
 * `DELETE sessions/:handle`**, or Express matches `"others"` as a handle. (The handle alphabet is 22
 * base64url characters, so `others` can never be a real one — this is belt and braces, and AC-9 tests it.)
 *
 * This is the ONLY controller under `auth/system` with a parameterised route, which is exactly why it is not
 * `AuthSystemController`: that one keeps its "no parameterised route" rule literally true.
 *
 * None of these handlers is `@AllowPasswordChangeGate()`: a `mustChangePassword` caller gets the existing
 * 403, and the exempt set stays exactly the three doors `CLAUDE.md` lists. The two DELETEs are mutating
 * methods, so they go through the global CSRF middleware and are in neither CSRF exemption list.
 */
@ApiTags('Auth')
@ApiCookieAuth('session')
@Controller('auth/system')
@UseGuards(SessionGuard)
export class AuthSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly tracker: SessionTrackerService,
    private readonly loginLog: LoginLogService,
  ) {}

  @Get('sessions')
  @ApiOperation({
    summary: 'List your own live sessions.',
    description:
      'The current session plus every OTHER live session of the caller (`others`, most recently active first). Each carries an opaque `handle` for revocation — never the session id. Sessions created before LOGIN-SESSIONS-1 shipped are not listed until their holder signs in again (within 24 h); the current session always renders, with a null IP and an `unknown` device if it predates the feature.',
  })
  @ApiOkResponse({
    description: 'Current and other live sessions.',
    type: SessionListResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No or expired session, or the account is gone.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'A password change is required first.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<SessionListResponseDto> {
    return this.sessions.list(contextOf(req, user));
  }

  // ⚠️ DECLARED BEFORE `sessions/:handle` — see the class doc.
  @Delete('sessions/others')
  @ApiOperation({
    summary: 'Sign out every other device.',
    description:
      'Ends every live session of the caller EXCEPT the current one, which stays signed in. Idempotent: with nothing else live it is a 200 with `revoked: 0`. Each revoked device gets a 401 on its next request and its realtime socket is closed within one revalidation sweep.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({
    description: 'How many sessions were ended.',
    type: RevokeSessionsResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No or expired session, or the account is gone.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'CSRF failure, or a password change is required first.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable. Nothing was revoked.',
    type: ErrorResponseDto,
  })
  revokeOthers(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<RevokeSessionsResponseDto> {
    return this.sessions.revokeOthers(contextOf(req, user));
  }

  @Delete('sessions/:handle')
  @ApiOperation({
    summary: 'Sign out one other device.',
    description:
      "Ends the caller's own session identified by `handle` (from `GET /auth/system/sessions`). A malformed handle, an unknown one, another user's, and one already revoked are ONE indistinguishable 404. The caller's own current handle is a 400: use logout for that.",
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({
    description: 'Ended. `revoked` is 1.',
    type: RevokeSessionsResponseDto,
  })
  @ApiBadRequestResponse({
    description: "The handle is the caller's own current session.",
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No or expired session, or the account is gone.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'CSRF failure, or a password change is required first.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description:
      'Malformed, unknown, foreign, expired or already-revoked handle (one body).',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable. Nothing was revoked.',
    type: ErrorResponseDto,
  })
  revokeOne(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedSystemUser,
    @Param('handle') handle: string,
  ): Promise<RevokeSessionsResponseDto> {
    return this.sessions.revokeOne(contextOf(req, user), handle);
  }

  @Get('login-history')
  @ApiOperation({
    summary: 'Your own sign-in history, last 90 days.',
    description:
      'Newest first. Records successful sign-ins, rejected sign-ins for YOUR account (a wrong password, or a suspended/deleted account — deliberately indistinguishable), and forced sign-outs by an administrator (without naming who). `limit` must be exactly 10, 20 or 50. A page beyond the last is a 200 with an empty `data`. Rows older than 90 days are never returned, even before the purge has run.',
  })
  @ApiOkResponse({
    description: "A page of the caller's login history.",
    type: LoginHistoryPageDto,
  })
  @ApiBadRequestResponse({
    description: '`page` < 1 or not an integer; `limit` not 10, 20 or 50.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No or expired session, or the account is gone.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'A password change is required first.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  loginHistory(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedSystemUser,
    @Query() query: ListLoginHistoryQueryDto,
  ): Promise<LoginHistoryPageDto> {
    return this.loginLog.listOwn(
      user.id,
      query.page,
      query.limit,
      this.tracker.handleOf(req.sessionID),
    );
  }
}
