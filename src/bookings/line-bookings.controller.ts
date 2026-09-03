import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import type { RequestWithLineUserId } from '../line/line.types';
import { BookingsService } from './bookings.service';
import {
  BookingRequestResponseDto,
  VenueAvailabilitySlotDto,
} from './dto/booking-response.dto';
import { CreateLineBookingDto } from './dto/create-line-booking.dto';
import { VenueAvailabilityQueryDto } from './dto/venue-availability-query.dto';

/**
 * The LINE-consumer half of `CLIENT-BOOKING-1`, route prefix `/api/v1/line-users`.
 *
 * ── WHY IT SHARES A BASE PATH WITH TWO CONTROLLERS IN ANOTHER MODULE ──
 * `line-users` is not a noun here, it is a GUARD: this is the third controller whose caller proves
 * identity with a LINE ID token rather than an Express session, and grouping by guard is the rule
 * `LineRegistrationController` already states for hosting the consumer venue reads. The alternative
 * — putting these on `VenuesController` or a new `bookings` base with a relaxed guard — is the same
 * mistake `SERVICE_CHANGES.md` §1 forbids: a class-level guard covers every route on the class.
 *
 * ── ROUTE ORDER (`SC-6`) ──
 * `SC-6` makes registration order load-bearing between `LineRegistrationController` and the admin
 * `LineUsersController`. **Neither route below participates in that**, and it is worth writing down
 * why rather than relying on it:
 *
 * | This controller | Admin `LineUsersController` | Collides? |
 * |---|---|---|
 * | `POST line-users/bookings` | has no `POST` at all | no |
 * | `GET line-users/venues/:id/availability` (3 segments) | `GET line-users` · `PATCH :id` · `PATCH :id/registration` | no — different method AND depth |
 *
 * `GET line-users/venues/:id` on `LineRegistrationController` does not shadow the 3-segment route
 * either: Express matches a pattern's full depth, so `/venues/:id` never captures `/venues/x/y`.
 * `BookingsModule` is therefore free to register after `LineModule`. If an admin `GET :id` is ever
 * added, this table is the thing to re-check.
 *
 * ⚠️ `POST /line-users/bookings` MUST be listed in `CSRF_EXEMPT_PATHS`. It is bearer-authenticated
 * and cookieless like `/register` and `/registration`, so the double-submit cookie it would
 * otherwise be asked for does not exist — the middleware runs before the router and would answer 403
 * before `LineIdTokenGuard` ever saw the request.
 */
@ApiTags('LINE Bookings')
@ApiBearerAuth()
@Controller('line-users')
export class LineBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post('bookings')
  @UseGuards(LineIdTokenGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit a booking request (always PENDING).',
    description:
      'Creates one `BookingRequest` and its `BookingSlot` children in a single transaction. A continuous span and a repeat-across-days request differ only in how many slots are sent (`D-C13` rule 2) — there is no mode flag. The caller must be `ALLOWED`; the venue must exist and be OPEN. Status is `PENDING` and nothing is held: several people may hold overlapping pending requests, and the approver picks one (`D-C13` rule 4). There is no `lineUserId` body field — the identity is the verified `sub`.',
  })
  @ApiCreatedResponse({
    description: 'The submitted request, with its human-readable `code`.',
    type: BookingRequestResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'An unknown extra key, a slot ending before it starts, a slot in the past (`D-C16`), slots that overlap each other, or a missing/blank `purpose` / `attendees`.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'The caller’s access is not ALLOWED (UNREGISTERED / PENDING / REJECTED / BLOCKED — one message for all four).',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such venue, or it has been deleted.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'The venue is closed, or a requested time collides with an already-APPROVED slot. The message names neither the holder nor their purpose (`D-C13`).',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  create(
    @Req() req: RequestWithLineUserId,
    @Body() dto: CreateLineBookingDto,
  ): Promise<BookingRequestResponseDto> {
    return this.bookings.createFromLine(req.lineUserId as string, dto);
  }

  @Get('venues/:id/availability')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'Read a venue’s occupied spans for a date range.',
    description:
      'Feeds the `#/venue/:id` calendar and its proportional 24-hour timeline bar. Returns every non-cancelled slot of an APPROVED or PENDING request that OVERLAPS the window — a span crossing midnight appears on every day it touches. 🔴 Approved and pending are returned as distinct states and must not be collapsed: red = taken, amber = somebody else has asked (`TRANSPORT.md` §3.1). 🔴 `purpose` and `requesterName` are `null` on somebody else’s pending request (`D-C13`).',
  })
  @ApiOkResponse({
    description: 'Occupied spans, `startAt ASC`.',
    type: [VenueAvailabilitySlotDto],
  })
  @ApiBadRequestResponse({
    description:
      'A malformed date, `to` before `from`, or a range wider than 366 days.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller’s access is not ALLOWED.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such venue, or it has been deleted.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  availability(
    @Req() req: RequestWithLineUserId,
    @Param('id') id: string,
    @Query() query: VenueAvailabilityQueryDto,
  ): Promise<VenueAvailabilitySlotDto[]> {
    return this.bookings.listVenueAvailability(
      req.lineUserId as string,
      id,
      query,
    );
  }
}
