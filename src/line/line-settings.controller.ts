import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import {
  LineUserSettingsResponseDto,
  LineUserVersionResponseDto,
  UpdateLineUserSettingsDto,
} from './dto/line-user-settings.dto';
import { LineIdTokenGuard } from './guards/line-id-token.guard';
import { LineUserService } from './line-user.service';
import type { RequestWithLineUserId } from './line.types';

/**
 * The settings-and-information branch of the client portal (Phase 7a), route prefix
 * `/api/v1/line-users`. Every route is guarded by `LineIdTokenGuard` (Bearer LINE ID token) and the
 * caller's identity is the verified `sub` on `req.lineUserId` — never a body/param value
 * (`LINK-LINE-1`). There is no `:id` anywhere on this class, so a cross-user read or write has no
 * shape to take.
 *
 * ── WHY ITS OWN CLASS ──
 * It shares the `line-users` base with three other controllers, because on this surface
 * `line-users` names the GUARD and not the noun (see `LineRegistrationController`'s note). It is a
 * fourth class rather than four more methods on `LineRegistrationController` for the reason that
 * file's name gives: registration and settings are different subjects, and that file is already the
 * longest controller in the module.
 *
 * ── 🔴 ROUTE ORDER (`SC-6`) IS LOAD-BEARING FOR THIS CLASS ──
 * `PATCH /line-users/settings` is a 2-segment `PATCH`, and so is the admin
 * `PATCH /line-users/:id` on `LineUsersController`. `settings` is a valid `:id` as far as Express is
 * concerned, so whichever registers FIRST wins. This controller MUST therefore be listed BEFORE
 * `LineUsersController` in `LineModule.controllers` — exactly the ordering rule that already
 * protects `PATCH /line-users/registration`. The two `GET`s collide with nothing (the admin class
 * has no `GET /line-users/:id`), but they are registered in the same place for the same reason.
 *
 * ── CSRF ──
 * ⚠️ `PATCH /line-users/settings` MUST be listed in `CSRF_EXEMPT_PATHS`. It is bearer-authenticated
 * and cookieless, so the double-submit cookie it would otherwise be asked for does not exist — and
 * the middleware runs before the router, so it would answer `403` before `LineIdTokenGuard` ever
 * saw the request. Both `GET`s need no entry: `ignoredMethods` exempts them by method.
 */
@ApiTags('LINE Settings')
@ApiBearerAuth()
@Controller('line-users')
export class LineSettingsController {
  constructor(private readonly users: LineUserService) {}

  @Get('settings')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: "Read the caller's client-portal settings.",
    description:
      'Header-derived and param-less: the caller reads only their own settings (identity = the verified `sub`). ' +
      '⚠️ A user who has never saved anything HAS NO ROW and gets the documented defaults with `updatedAt: null` — ' +
      'this read never writes, so a follower who never opens the settings screen costs zero rows forever (`Q-C9`).',
  })
  @ApiOkResponse({
    description: 'The caller’s settings, or the defaults when they have none.',
    type: LineUserSettingsResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  getSettings(
    @Req() req: RequestWithLineUserId,
  ): Promise<LineUserSettingsResponseDto> {
    return this.users.getSettings(req.lineUserId as string);
  }

  @Patch('settings')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: "Update the caller's client-portal settings (partial, merged).",
    description:
      'Every field is optional and **absence means unchanged**. `notifications` is merged PER KEY, so sending ' +
      '`{"notifications":{"decisions":false}}` leaves `announcements` and `reminders` exactly as they were. ' +
      'The row is created on first save. Unknown keys, a theme outside `light|dark|system`, and a non-boolean ' +
      '(or explicitly `null`) toggle are all `400`. There is no `lineUserId` body field — the identity is the verified `sub`.',
  })
  @ApiOkResponse({
    description: 'The caller’s settings after the merge.',
    type: LineUserSettingsResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'An unknown key, an unsupported theme, or a non-boolean notification value.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  patchSettings(
    @Req() req: RequestWithLineUserId,
    @Body() dto: UpdateLineUserSettingsDto,
  ): Promise<LineUserSettingsResponseDto> {
    return this.users.patchSettings(req.lineUserId as string, dto);
  }

  @Get('version')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'The version this API is running, for the `#/version` screen.',
    description:
      'The consumer counterpart of the admin `GET /system/version`, which is behind the cookie session the ' +
      'client portal does not have (`NEEDS_DESIGN.md` §3). Authenticated on purpose and deliberately NOT on the ' +
      'public `/health` probe: publishing an exact build to the open internet is how a scanner matches a CVE to a ' +
      'deployment. Carries no per-user data — every caller gets the identical answer.',
  })
  @ApiOkResponse({
    description: 'The running version.',
    type: LineUserVersionResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  getVersion(): LineUserVersionResponseDto {
    return this.users.getClientVersion();
  }
}
