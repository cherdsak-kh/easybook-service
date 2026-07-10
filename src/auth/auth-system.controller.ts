import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CsrfService } from '../csrf/csrf.service';
import {
  sessionCookieName,
  sessionCookieOptions,
} from '../session/session.middleware';
import {
  destroySession,
  regenerateSession,
  saveSession,
} from '../session/session.util';
import { toSystemUserDto } from '../system-users/system-users.fields';
import { SystemUserResponseDto } from '../system-users/dto/system-user-response.dto';
import { AuthService } from './auth.service';
import type { AuthenticatedSystemUser } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { CsrfTokenResponseDto } from './dto/csrf-token-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { SessionGuard } from './guards/session.guard';
import { LoginThrottleGuard } from './guards/login-throttle.guard';
import {
  LOGIN_IP_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
  resolveIp,
} from './login-throttle.key';

/** Back-office authentication actions. Route prefix: `/api/v1/auth/system`. */
@ApiTags('Auth')
@Controller('auth/system')
export class AuthSystemController {
  constructor(
    private readonly auth: AuthService,
    private readonly csrf: CsrfService,
    private readonly config: ConfigService,
  ) {}

  @Get('csrf')
  @ApiOperation({
    summary: 'Issue a CSRF token.',
    description:
      'Safe method, no state change, no session required. Echo the returned token in the `x-csrf-token` header on every state-changing request. The token is not one-shot and survives login.',
  })
  @ApiOkResponse({
    description: 'A CSRF token and its signed cookie.',
    type: CsrfTokenResponseDto,
  })
  getCsrf(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): CsrfTokenResponseDto {
    return { csrfToken: this.csrf.generateToken(req, res) };
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginThrottleGuard)
  @Throttle({ [LOGIN_IP_EMAIL_THROTTLER]: {}, [LOGIN_IP_THROTTLER]: {} })
  @ApiOperation({
    summary: 'Log in with email + password.',
    description:
      'Sets the `eb.sid` session cookie. Returns the user, never a token. Rate limited to 5 attempts / 15 min per (IP + email) and 20 / 15 min per IP.',
  })
  @ApiHeader({
    name: 'x-csrf-token',
    required: true,
    description: 'From `GET /auth/system/csrf`.',
  })
  @ApiOkResponse({ description: 'Authenticated.', type: LoginResponseDto })
  @ApiUnauthorizedResponse({
    description:
      'Unknown email, wrong password, suspended, or deleted — one identical response.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Missing or stale CSRF token.',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limited. Carries a `Retry-After` header.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    const ip = resolveIp(req);
    const user = await this.auth.validateCredentials(
      dto.email,
      dto.password,
      ip,
    );

    // Session fixation defence (AC-8): rotate the id BEFORE assigning, because regenerate()
    // wipes the session payload. Then save() explicitly, so a Redis outage surfaces as 503
    // rather than a silently-lost session.
    await regenerateSession(req);
    req.session.systemUserId = user.id;
    req.session.createdAt = Date.now();
    await saveSession(req);

    await this.auth.touchLastLogin(user.id);
    await this.auth.clearLoginThrottle(ip, dto.email);

    return user;
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'Destroy the current session.',
    description:
      'Removes the session from Redis and clears the cookie. A replayed logout returns 401 — the session no longer exists.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({
    description: 'Session destroyed.',
    schema: { properties: { success: { type: 'boolean', example: true } } },
  })
  @ApiUnauthorizedResponse({
    description: 'No, expired, or already-destroyed session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Missing or stale CSRF token.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: true }> {
    await destroySession(req);
    // The clear options must mirror the set options or the browser ignores them.
    res.clearCookie(
      sessionCookieName(this.config),
      sessionCookieOptions(this.config),
    );
    return { success: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'The currently authenticated back-office user.',
    description:
      'Read fresh from the database on every request (D-9), so a demotion or suspension is reflected immediately. Used to rehydrate a session after a page reload or a backend restart.',
  })
  @ApiOkResponse({
    description: 'The current user.',
    type: SystemUserResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session, expired, suspended, or deleted user.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  me(@CurrentUser() user: AuthenticatedSystemUser): SystemUserResponseDto {
    return toSystemUserDto(user);
  }
}
