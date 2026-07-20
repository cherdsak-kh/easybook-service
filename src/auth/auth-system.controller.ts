import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBadGatewayResponse,
  ApiBody,
  ApiConsumes,
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
import { memoryStorage } from 'multer';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CsrfService } from '../csrf/csrf.service';
import {
  AVATAR_MULTER_SIZE_LIMIT,
  AvatarUploadService,
} from './avatar-upload.service';
import { AVATAR_REQUIRED } from '../storage/storage.errors';
import { SystemUsersService } from '../system-users/system-users.service';
import { MulterErrorTo400Filter } from './filters/multer-error.filter';
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
import { AllowPasswordChangeGate } from './decorators/allow-password-change-gate.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CsrfTokenResponseDto } from './dto/csrf-token-response.dto';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { UpdateOwnProfileDto } from './dto/update-own-profile.dto';
import { SessionGuard } from './guards/session.guard';
import { LoginThrottleGuard } from './guards/login-throttle.guard';
import {
  LOGIN_IP_EMAIL_THROTTLER,
  LOGIN_IP_THROTTLER,
  resolveIp,
} from './login-throttle.key';

/**
 * Back-office authentication actions. Route prefix: `/api/v1/auth/system`.
 *
 * **STANDING RULE: this controller has NO parameterised route, and must never gain one.** Every path
 * is a literal (`csrf`, `login`, `logout`, `me`, `password`, `me/avatar`), so nothing can shadow
 * anything (`GET me` and `PATCH me` differ by method). If a `@Get(':id')`-style route is ever needed
 * here, it MUST be declared after every literal — otherwise it swallows them.
 *
 * **The forced-reset gate:** `@AllowPasswordChangeGate()` marks the EXACTLY THREE session-guarded
 * handlers that stay reachable while `mustChangePassword` is true — `logout`, `GET me`,
 * `POST password`. `PATCH me` and `POST me/avatar` are deliberately NOT exempt: editing your name or
 * avatar is not a prerequisite for escaping the gate. Widening this set is a security hole; narrowing
 * it is a permanent lockout.
 */
@ApiTags('Auth')
@Controller('auth/system')
export class AuthSystemController {
  constructor(
    private readonly auth: AuthService,
    private readonly csrf: CsrfService,
    private readonly config: ConfigService,
    private readonly systemUsers: SystemUsersService,
    private readonly avatars: AvatarUploadService,
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
  // EXEMPT from the forced-reset gate: a user must always be able to leave. Trapping someone in a
  // screen they cannot exit is unacceptable, and it is not a security gain — logout destroys authority.
  @AllowPasswordChangeGate()
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'Destroy the current session.',
    description:
      'Removes the session from Redis and clears the cookie. A replayed logout returns 401 — the session no longer exists. Reachable while a password change is required.',
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
  // EXEMPT from the forced-reset gate: the SPA reads `mustChangePassword` from HERE to route to the
  // reset screen (AC-F5) and to rehydrate after a reload. Blocking it means the SPA cannot tell WHY
  // it is being 403'd — the classic self-inflicted lockout.
  @AllowPasswordChangeGate()
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'The currently authenticated back-office user.',
    description:
      'Read fresh from the database on every request (D-9), so a demotion or suspension is reflected immediately. Used to rehydrate a session after a page reload or a backend restart. Reachable while a password change is required — `mustChangePassword` in this body is what the SPA routes off.',
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

  @Patch('me')
  @UseGuards(SessionGuard)
  // NOT exempt from the gate — editing your name is not a prerequisite for escaping it.
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'Update your own profile.',
    description:
      'Self-service. Accepts EXACTLY `firstName`, `lastName`, `phoneNumber`, `profilePictureUrl`. `role`, `isActive`, `departmentId`, `personnelRoleId`, `email`, `password` and `lineUserId` are absent from the DTO, so any attempt to set one is a 400 — a SUPER_ADMIN manages those via PATCH /system-users/:id. An empty body is a 400. `phoneNumber`/`profilePictureUrl` accept an explicit null to clear them.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Updated.', type: SystemUserResponseDto })
  @ApiBadRequestResponse({
    description: 'Empty body, a forbidden key, or a bad value.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'CSRF failure, or a password change is required.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  updateOwnProfile(
    @CurrentUser() user: AuthenticatedSystemUser,
    @Body() dto: UpdateOwnProfileDto,
  ): Promise<SystemUserResponseDto> {
    return this.systemUsers.updateOwnProfile(user.id, dto);
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  // EXEMPT from the forced-reset gate: this is THE door out. Blocking it is a permanent lockout.
  // No RolesGuard — every authenticated role may change their own password.
  @AllowPasswordChangeGate()
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'Change your own password (forced or voluntary).',
    description:
      'Requires `currentPassword`: without it a hijacked session becomes a permanent account takeover in one request. A WRONG current password is a 400, never a 401 — the session is valid, only the re-auth failed, and a 401 would log you out for a typo. The new password must be >= 12 chars and differ from the current one. On success `mustChangePassword` clears and the very NEXT request to any previously-gated route succeeds on the same cookie — no re-login, because SessionGuard re-reads the user every request. The session is deliberately NOT destroyed.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({
    description: 'Password changed.',
    schema: { properties: { success: { type: 'boolean', example: true } } },
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, the current password is wrong, or the new password matches the current one.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session — or a suspended/deleted user, which fires first.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Missing or stale CSRF token. NEVER the forced-reset gate.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  async changePassword(
    @CurrentUser() user: AuthenticatedSystemUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ success: true }> {
    await this.auth.changeOwnPassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    return { success: true };
  }

  @Post('me/avatar')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  // NOT exempt from the gate — uploading an avatar is not a prerequisite for escaping it.
  //
  // memoryStorage: the object is <= 2 MiB and goes straight to R2; nothing should ever hit local
  // disk. `limits.fileSize` aborts the stream AT the limit, so an oversized upload is never fully
  // buffered. `limits.files: 1` rejects multi-part floods.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      // AVATAR_MULTER_SIZE_LIMIT is AVATAR_MAX_BYTES + 1 — busboy's limit is exclusive. See the
      // constant's doc-comment; passing 2 MiB here would reject a file of exactly 2 MiB.
      limits: { fileSize: AVATAR_MULTER_SIZE_LIMIT, files: 1 },
    }),
  )
  // Multer raises MulterError(LIMIT_FILE_SIZE), which Nest surfaces as 413 — but AC-B13 demands 400.
  // This filter is what makes that true; without it the AC fails SILENTLY.
  @UseFilters(MulterErrorTo400Filter)
  @ApiCookieAuth('session')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG, PNG or WEBP. Max 2 MB.',
        },
      },
    },
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Upload your own avatar.',
    description:
      'Multipart, one part named `file`. The server enforces size (2 MB) and type: the declared MIME is a first filter only — the real control is a MAGIC-BYTE sniff, and the stored ContentType and key extension are derived from the SNIFFED type, never from the filename. Returns the updated user with `profilePictureUrl` already pointing at the new object; re-render from this body rather than constructing the URL. The CSRF token is a HEADER and works fine with multipart — do not put it in the form body.',
  })
  @ApiOkResponse({
    description: 'Uploaded. The updated user.',
    type: SystemUserResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'No file, wrong field name, unsupported/mismatched image type, or larger than 2 MB.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'CSRF failure, or a password change is required.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'The object store rejected the upload or was unreachable.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  uploadOwnAvatar(
    @CurrentUser() user: AuthenticatedSystemUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<SystemUserResponseDto> {
    if (!file) throw new BadRequestException(AVATAR_REQUIRED);
    return this.avatars.replaceAvatar(user, file);
  }
}
