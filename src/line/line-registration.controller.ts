import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateLineUserRegistrationDto } from './dto/create-line-user-registration.dto';
import { LineUserStatusResponseDto } from './dto/line-user-status-response.dto';
import { LineIdTokenGuard } from './guards/line-id-token.guard';
import { LineUserService } from './line-user.service';
import type { RequestWithLineUserId } from './line.types';

/**
 * The LINE-consumer (LIFF client) surface, route prefix `/api/v1/line-users`. This is the app's
 * first LINE-authenticated surface: every method is guarded by `LineIdTokenGuard` (Bearer LINE ID
 * token), NOT the cookie session that guards the admin `LineUsersController`. The caller's identity
 * is the verified `sub` on `req.lineUserId` — never a body/param value (LINK-LINE-1).
 *
 * It shares the `line-users` base with the admin `LineUsersController` without collision: the admin
 * controller owns `GET /` and `PATCH /:id`, this one owns the literal `GET /status` and
 * `POST /register` — different methods and no `GET /:id` to shadow `GET /status`.
 *
 * `POST /register` is exempt from CSRF (bearer, cookieless — see `CSRF_EXEMPT_PATHS`); `GET /status`
 * is a GET and already CSRF-safe.
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

  @Post('register')
  @UseGuards(LineIdTokenGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit the registration form (UNREGISTERED → PENDING).',
    description:
      'Creates the 1:1 registration for the authenticated LINE user and moves them to `PENDING` (rich menu stays `TYPE_1`). Returns the caller’s status view so the frontend can route to the Pending screen without a second call. There is no `lineUserId` body field — the identity is the verified `sub`.',
  })
  @ApiCreatedResponse({
    description: 'Registered; access is now PENDING.',
    type: LineUserStatusResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Missing/blank field, bad phone, or an unknown extra key.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Already registered, or the student/staff ID is taken.',
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
}
