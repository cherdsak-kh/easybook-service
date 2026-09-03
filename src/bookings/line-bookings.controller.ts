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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import type { RequestWithLineUserId } from '../line/line.types';
import { BookingsService } from './bookings.service';
import {
  BookingDetailResponseDto,
  BookingListItemDto,
  BookingRequestResponseDto,
  VenueAvailabilitySlotDto,
} from './dto/booking-response.dto';
import { CreateLineBookingDto } from './dto/create-line-booking.dto';
import { ListLineBookingsQueryDto } from './dto/list-line-bookings-query.dto';
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
 * | `GET line-users/bookings` (2 segments) | `GET line-users` (1) · `PATCH :id` (2) | no — different depth, then different method |
 * | `GET line-users/bookings/:id` (3) | `PATCH :id/registration` (3, literal 3rd segment) | no — different method |
 * | `GET line-users/venues/:id/availability` (3) | as above | no — different method AND depth |
 * | `PATCH line-users/bookings/:id/cancel` (4) | nothing at depth 4 | no |
 * | `PATCH line-users/bookings/:id/slots/:slotId/cancel` (6) | nothing at depth 6 | no |
 *
 * `GET line-users/venues/:id` on `LineRegistrationController` does not shadow the 3-segment route
 * either: Express matches a pattern's full depth, so `/venues/:id` never captures `/venues/x/y`.
 * `BookingsModule` is therefore free to register after `LineModule`.
 *
 * 🔴 THE ONE ROW THAT WOULD BREAK IF THE ADMIN CONTROLLER GREW: an admin `GET line-users/:id` would
 * be a 2-segment `GET` and would shadow `GET line-users/bookings` if it registered first. There is
 * no such route today, and this is the table to re-check on the day somebody adds one — the failure
 * is a *silent* one, a My Bookings list answering with a LINE user profile.
 *
 * ── CSRF ──
 * ⚠️ `POST /line-users/bookings` MUST be listed in `CSRF_EXEMPT_PATHS`. It is bearer-authenticated
 * and cookieless like `/register` and `/registration`, so the double-submit cookie it would
 * otherwise be asked for does not exist — the middleware runs before the router and would answer 403
 * before `LineIdTokenGuard` ever saw the request.
 *
 * 🔴 THE TWO `PATCH` ROUTES CANNOT USE THAT LIST AT ALL. It is matched by exact `req.path`, and both
 * carry path parameters — which is why `csrf.service.ts` grew `CSRF_EXEMPT_PATTERNS`. The two GETs
 * need no entry either way: `ignoredMethods` already exempts them by method.
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

  @Get('bookings')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'List the caller’s own booking requests (`#/bookings`).',
    description:
      'Scoped to the verified `sub` — there is no parameter that widens it, and ownership is part of the query rather than a filter applied afterwards. Unpaginated: this is one user’s own bookings, and the screen’s four accordion groups are counted over the whole set. 🔴 `status` filters the four STORED statuses; the screen paints SIX, deriving `สิ้นสุดแล้ว` and `หมดเวลาพิจารณา` from `status` + `lastEndAt` at read time. Nothing expires in the database.',
  })
  @ApiOkResponse({ type: [BookingListItemDto] })
  @ApiBadRequestResponse({
    description:
      'An unknown query parameter, an invalid `status` or `sort`, or a `q` longer than 100 characters.',
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
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  list(
    @Req() req: RequestWithLineUserId,
    @Query() query: ListLineBookingsQueryDto,
  ): Promise<BookingListItemDto[]> {
    return this.bookings.listUserBookings(req.lineUserId as string, query);
  }

  @Get('bookings/:id')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'Read one of the caller’s own bookings, by id **or** by code.',
    description:
      '`:id` accepts the cuid (what `#/booking/:id` navigates by) or the human-readable `code` with or without a leading `#` (what `#/sent/:id` has, and what a user pastes out of LINE). 🔴 Somebody else’s booking is a **404, never a 403** — `code` is a guessable label, so a distinguishable answer would be an enumeration oracle over every booking in the product. Carries `cancelLeadMinutes` so the client can both hide the cancel control and word its own Thai explanation with the real number.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid/expired/wrong-aud LINE ID token.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'The caller’s access is not ALLOWED.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such booking — or it belongs to somebody else.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  detail(
    @Req() req: RequestWithLineUserId,
    @Param('id') id: string,
  ): Promise<BookingDetailResponseDto> {
    return this.bookings.getUserBookingDetail(req.lineUserId as string, id);
  }

  @Patch('bookings/:id/cancel')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'Withdraw a PENDING request (`Q-C4`).',
    description:
      'Sets the request to `CANCELLED` and marks every live child slot cancelled in one transaction — `Q-C4` ② puts the truth at slot level, so flipping the parent alone would leave rows the venue calendar still paints. 🔴 `PENDING` only: an APPROVED booking is cancelled one slot at a time, and `REJECTED`/`CANCELLED` are terminal. The denormalised span is deliberately NOT recomputed — a fully cancelled request keeps its original dates so the history list still has something to sort it by.',
  })
  @ApiOkResponse({
    description: 'The booking as it now stands.',
    type: BookingDetailResponseDto,
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
    description: 'No such booking — or it belongs to somebody else.',
    type: ErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The request is not `PENDING`. Approved bookings are cancelled per slot; rejected and cancelled ones are terminal.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  cancel(
    @Req() req: RequestWithLineUserId,
    @Param('id') id: string,
  ): Promise<BookingDetailResponseDto> {
    return this.bookings.cancelPendingBooking(req.lineUserId as string, id);
  }

  @Patch('bookings/:id/slots/:slotId/cancel')
  @UseGuards(LineIdTokenGuard)
  @ApiOperation({
    summary: 'Cancel ONE slot of an APPROVED booking (`Q-C4` ②).',
    description:
      'A three-slot request whose Monday has already begun can still have its Tuesday and Wednesday cancelled; the lead-time check runs against **that slot’s** `startAt`, never the request’s. 🔴 The slot frees the venue calendar **immediately** — availability filters `isCancelled` at slot level, so there is nothing to invalidate — and requests previously auto-rejected for it are NOT revived (`Q-C4`). When the last live slot goes, the request becomes `CANCELLED` by computation; otherwise `firstStartAt`/`lastEndAt` are recomputed over what remains, in the same transaction.',
  })
  @ApiOkResponse({
    description: 'The booking as it now stands.',
    type: BookingDetailResponseDto,
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
    description:
      'No such booking (or it is somebody else’s), or no such slot on it.',
    type: ErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'The booking is not `APPROVED`, the slot is already cancelled, or it starts within the cancellation lead time. 🔴 The lead time is enforced HERE — a hidden button is UX, never an authorisation boundary.',
    type: ErrorResponseDto,
  })
  @ApiBadGatewayResponse({
    description: 'LINE verification endpoint unreachable (retryable).',
    type: ErrorResponseDto,
  })
  cancelSlot(
    @Req() req: RequestWithLineUserId,
    @Param('id') id: string,
    @Param('slotId') slotId: string,
  ): Promise<BookingDetailResponseDto> {
    return this.bookings.cancelApprovedSlot(
      req.lineUserId as string,
      id,
      slotId,
    );
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
