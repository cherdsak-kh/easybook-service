import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { ListVenuesQueryDto, VenueResponseDto } from '../venues/dto/venue.dto';
import { VenuesService } from '../venues/venues.service';
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
 * still falls through to `:id`. The admin controller has no `GET /line-users/:id`, so `GET /status`,
 * `GET /registration/options` and the two venue reads collide with nothing.
 *
 * `POST /register` and `PATCH /registration` are exempt from CSRF (bearer, cookieless — see
 * `CSRF_EXEMPT_PATHS`); every GET here is a GET and already CSRF-safe.
 *
 * ⚠️ IT ALSO HOSTS THE CONSUMER VENUE READS (`CLIENT-VENUES-1`), which are about venues rather than
 * registration. They live here because the guard is the organising principle, not the noun: this is
 * the only controller in the app whose caller proves identity with a LINE ID token. The alternative
 * — relaxing `VenuesController`'s class-level `@UseGuards(SessionGuard, RolesGuard)` — would open
 * the SEVEN admin write routes that class also holds, so it is explicitly forbidden
 * (`SERVICE_CHANGES.md` §1).
 */
@ApiTags('LINE Registration')
@ApiBearerAuth()
@Controller('line-users')
export class LineRegistrationController {
  constructor(
    private readonly users: LineUserService,
    private readonly venues: VenuesService,
  ) {}

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
    // `lineProfile` rides along on the same verified payload as the `sub` and keeps our copy of
    // the caller's LINE display name and picture current — LINE fires no event when either
    // changes, so this is one of only two moments we can find out. It changes nothing about this
    // response; see `LineUserService.syncProfile`. Still identity from `sub` and `sub` alone.
    return this.users.getStatus(req.lineUserId as string, req.lineProfile);
  }

  @Get('registration/options')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'List the selectable department + personnel-role options.',
    description:
      'Combined payload so the registration/edit form makes ONE call. Returns only NON-deleted options, each list ordered `name ASC`. Ids feed `departmentId`/`personnelRoleId` on register/edit. System-reserved options are never returned.',
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

  /**
   * ⚠️ LITERAL SEGMENT, REGISTERED BEFORE THE ADMIN CONTROLLER'S PARAMETERISED ROUTES — the same
   * SC-6 ordering that protects `PATCH /line-users/registration`. The admin controller has no
   * `GET /line-users/:id` today, so nothing shadows this; if one is ever added, this ordering is
   * what keeps `venues` from being read as a user id.
   */
  @Get('venues')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'List venues for the LIFF catalogue screen.',
    description:
      'The consumer half of `GET /venues`, which is admin-only at class level and unreachable with a LINE ID token. Same service, same shape, same search/filter behaviour — a different guard in front of it. Unpaginated and `name ASC`, exactly like the admin list. CLOSED venues ARE returned (`isOpen: false`, with `closedReason`): a closed venue stays visible to end users and simply accepts no new booking requests. Soft-deleted venues are never returned.',
  })
  @ApiOkResponse({
    description: 'Every non-deleted venue matching the filters, `name ASC`.',
    type: [VenueResponseDto],
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  listVenues(@Query() query: ListVenuesQueryDto): Promise<VenueResponseDto[]> {
    return this.venues.list(query);
  }

  @Get('venues/:id')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'Read one venue for the LIFF detail screen.',
    description:
      'There is no admin equivalent — the back office renders detail from the row its unpaginated list already holds, whereas `#/venue/:id` is a URL and can be opened cold, deep-linked, or restored by LINE. A CLOSED venue returns normally, because the screen renders `closedReason` as an alert; a soft-deleted or unknown id is a 404, and the two are byte-identical.',
  })
  @ApiOkResponse({ description: 'The venue.', type: VenueResponseDto })
  @ApiNotFoundResponse({
    description: 'No such venue, or it has been deleted.',
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
  getVenue(@Param('id') id: string): Promise<VenueResponseDto> {
    return this.venues.findById(id);
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
    description: 'This LINE user is already registered.',
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
      'A caller whose `access` is strictly `PENDING` may update all their registration fields. `ALLOWED`/`BLOCKED`/`UNREGISTERED` → `403` (no partial write). `access` stays `PENDING` and the rich menu stays `TYPE_1`; no LINE push fires. Same validation as register (options must be non-deleted). No `lineUserId` body field.',
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
