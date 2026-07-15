import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { LineUserStatusResponseDto } from './dto/line-user-status-response.dto';
import { RegistrationOptionsResponseDto } from './dto/registration-options-response.dto';
import { UpdateLineUserRegistrationDto } from './dto/update-line-user-registration.dto';
import { LineIdTokenGuard } from './guards/line-id-token.guard';
import { LineUserService } from './line-user.service';
import type { RequestWithLineUserId } from './line.types';

/**
 * The LINE-consumer (LIFF client) surface, route prefix `/api/v1/line-users`. This is the app's
 * first LINE-authenticated surface: every method is guarded by `LineIdTokenGuard` (Bearer LINE ID
 * token), NOT the cookie session that guards the admin `LineUsersController`. The caller's identity
 * is the verified `sub` on `req.lineUserId` — never a body/param value (LINK-LINE-1).
 *
 * It shares the `line-users` base with the admin `LineUsersController`. This controller MUST be
 * registered BEFORE the admin one in `LineModule.controllers` (SC-6) so its literal
 * `PATCH /line-users/registration` route wins over the admin `PATCH /line-users/:id`; a real cuid
 * still falls through to `:id`. The admin controller has no `GET /line-users/:id`, so `GET /status`
 * and `GET /registration/options` collide with nothing.
 *
 * `POST /register` and `PATCH /registration` are exempt from CSRF (bearer, cookieless — see
 * `CSRF_EXEMPT_PATHS`); the two GETs are GETs and already CSRF-safe.
 */
@ApiTags('LINE Registration')
@ApiBearerAuth()
@Controller('line-users')
export class LineRegistrationController {
  constructor(private readonly users: LineUserService) {}

  @Get('status')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: "Get the authenticated LINE user's access status + registration.",
    description:
      'Header-derived and param-less: the caller reads only their own status (identity = the verified `sub`). A LIFF-first user with no prior row gets a fresh `UNREGISTERED` state and `registration: null`. The single call the client portal makes after LIFF auth to pick which of the four screens to render.',
  })
  @ApiOkResponse({
    description: 'The caller’s current status.',
    type: LineUserStatusResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  getStatus(
    @Req() req: RequestWithLineUserId,
  ): Promise<LineUserStatusResponseDto> {
    return this.users.getStatus(req.lineUserId as string);
  }

  @Get('registration/options')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'List the selectable department + personnel-role options.',
    description:
      'Combined payload so the registration/edit form makes ONE call. Returns only NON-deleted options, each list ordered `name ASC`. Ids feed `departmentId`/`personnelRoleId` on register/edit.',
  })
  @ApiOkResponse({
    description: 'The available options.',
    type: RegistrationOptionsResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  getOptions(): Promise<RegistrationOptionsResponseDto> {
    return this.users.getRegistrationOptions();
  }

  @Post('register')
  @UseGuards(LineIdTokenGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit the registration form (UNREGISTERED → PENDING).',
    description:
      'Creates the 1:1 registration for the authenticated LINE user and moves them to `PENDING` (rich menu stays `TYPE_1`). `departmentId`/`personnelRoleId` must reference non-deleted options. Returns the caller’s status view so the frontend can route to the Pending screen without a second call. There is no `lineUserId` body field — the identity is the verified `sub`.',
  })
  @ApiCreatedResponse({
    description: 'Registered; access is now PENDING.',
    type: LineUserStatusResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Missing/blank field, bad phone, a deleted/unknown option id, or an unknown extra key.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Already registered, or the staff ID is taken.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  register(
    @Req() req: RequestWithLineUserId,
    @Body() dto: CreateLineUserRegistrationDto,
  ): Promise<LineUserStatusResponseDto> {
    return this.users.register(req.lineUserId as string, dto);
  }

  @Patch('registration')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'Edit your registration while PENDING (full re-submit).',
    description:
      'A caller whose `access` is strictly `PENDING` may update all their registration fields. `ALLOWED`/`BLOCKED`/`UNREGISTERED` → `403` (no partial write). `access` stays `PENDING` and the rich menu stays `TYPE_1`; no LINE push fires. Same validation as register (options must be non-deleted; a `staffId` taken by another registration → `409`; re-submitting your own is fine). No `lineUserId` body field.',
  })
  @ApiOkResponse({
    description: 'Updated; still PENDING.',
    type: LineUserStatusResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Missing/blank field, bad phone, a deleted/unknown option id, or an unknown extra key.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller is not PENDING (ALLOWED / BLOCKED / UNREGISTERED).',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'The staff ID is taken by another registration.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  updateRegistration(
    @Req() req: RequestWithLineUserId,
    @Body() dto: UpdateLineUserRegistrationDto,
  ): Promise<LineUserStatusResponseDto> {
    return this.users.updateRegistration(req.lineUserId as string, dto);
  }
}
