import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import type { AuthenticatedSystemUser } from '../auth/auth.types';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { AdminBookingsService } from './admin-bookings.service';
import {
  AdminBookingRequestDetailDto,
  ApproveBookingResponseDto,
  BookingPreflightResponseDto,
  PaginatedBookingRequestsResponseDto,
} from './dto/admin-booking-response.dto';
import {
  BookingPreflightDto,
  CancelBookingRequestDto,
  CreateDirectBookingDto,
  RejectBookingRequestDto,
} from './dto/admin-booking-write.dto';
import { ListBookingRequestsQueryDto } from './dto/list-booking-requests-query.dto';

/**
 * `คำขอจองสถานที่` — route prefix `/api/v1/booking-requests`.
 *
 * ⚠️ `VIEWER` MAY READ, AND MAY CHANGE NOTHING — the same split `/venues`, `/system-users` and
 * `/line-users` settled on. A supervisor is expected to look at the approval queue; deciding on it is
 * an action. `@Roles` on the four write verbs is the boundary, and a route that forgets to list a
 * role fails CLOSED. Hiding a button is UX and stops nothing (AC-BR6, AC-BR7).
 * ⚠️ `preflight` ADMITS `VIEWER` DESPITE BEING A `@Post`: the verb carries a list of spans that does
 * not fit a query string, and the handler writes nothing at all. The boundary is what a route DOES,
 * not which HTTP verb it answers on.
 *
 * ⚠️ CSRF APPLIES TO EVERY POST HERE — the four write routes AND `preflight` — and is a HEADER, never
 * a body field (`forbidNonWhitelisted` would 400 a `_csrf` key before the middleware ever saw it).
 * This surface stands on an `express-session` cookie, unlike the LIFF booking routes which carry a
 * bearer id token; nothing here belongs in `CSRF_EXEMPT_PATHS`.
 *
 * ⚠️ NOT THROTTLED, deliberately. `ThrottlerModule` exists in this repo to slow password guessing at
 * `login`. These routes sit behind an identified staff session, and the genuinely dangerous cases —
 * a double-tap on approve, two people deciding at once — are closed at the right layer by the
 * advisory lock, the conditional `updateMany` and the exclusion constraint. A throttle here would
 * only inconvenience someone working quickly.
 *
 * ── 🔴 Route ORDER matters ──
 * `direct` and `preflight` are literal segments that a `:id` route would otherwise capture, so both
 * are declared FIRST. State the truth plainly: with exactly these seven routes the collision is NOT
 * reachable — Nest matches on method and segment count, and there is no single-segment `POST /:id`.
 * The ordering is here for the day somebody adds `POST /booking-requests/:id` (edit a request): on
 * that day both would be swallowed silently, and the symptom would be a 404 complaining about an id
 * named "direct". Same reasoning `VenuesController` records for `photos` and `CLAUDE.md` records for
 * the two LINE controllers.
 */
@ApiTags('Booking requests')
@ApiCookieAuth('session')
@Controller('booking-requests')
@UseGuards(SessionGuard, RolesGuard)
export class BookingRequestsController {
  constructor(private readonly bookings: AdminBookingsService) {}

  // ── DECLARED FIRST: a literal segment ahead of every `:id` route. See the class note. ───────────

  @Post('direct')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'จองแทน — staff book a room outright, already approved.',
    description:
      'Creates a request with `status = APPROVED` in one transaction: creation IS the approval (`D-C18`), so `createdById` and `approvedById` are both the caller and `approvedAt` is now. Two mutually exclusive shapes — (A) `lineUserId` for a LINE user who has an account, or (B) `requesterName` + `contactPhone` (both required) for an outside body, optionally with `departmentId`. Sending both shapes is a 400. ADR-001 applies exactly as it does to approve: every overlapping PENDING request is auto-rejected in this same transaction and reported in `autoRejected`. A CLOSED venue is accepted — `isOpen` refuses new REQUESTS and a staff lock is not a request; the response carries `venue.isOpen` so the screen can warn. `attendees` is deliberately NOT checked against the venue capacity.',
  })
  @ApiCreatedResponse({
    description: 'Created and approved.',
    type: ApproveBookingResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, both origin shapes sent at once, a slot ending before it starts / starting in the past / overlapping another slot of the same request, or an unusable `lineUserId` / `departmentId`.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted venue.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'A requested span overlaps an APPROVED, non-cancelled slot, or two decisions on this venue collided.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  createDirect(
    @Body() dto: CreateDirectBookingDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<ApproveBookingResponseDto> {
    return this.bookings.createDirect(dto, { id: user.id, role: user.role });
  }

  /**
   * ── 🔴 A POST THAT CREATES NOTHING (`G1`) ──
   * `@HttpCode(HttpStatus.OK)` is MANDATORY: Nest answers a `@Post` with `201`, which would claim a
   * resource was created. Nothing here writes — no lock, no transaction, no row.
   *
   * ⚠️ IT IS STILL A POST, SO CSRF STILL APPLIES. The verb is a POST because a list of up to sixty
   * spans does not belong in a query string, not because anything changes; callers must send
   * `x-csrf-token` exactly as they do on the four write routes.
   *
   * ⚠️ `VIEWER` IS ADMITTED HERE AND ON NO OTHER POST on this controller. This is a read dressed as a
   * POST, and a supervisor may look at what a set of hours would collide with.
   */
  @Post('preflight')
  @HttpCode(HttpStatus.OK)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary:
      'Preview the conflicts of UNSAVED spans — the create dialog’s live banner.',
    description:
      'Answers two questions about spans that are not in the database yet: do they clash with an APPROVED booking (which would 409 on submit), and which PENDING requests would ADR-001 auto-reject if they were submitted — named, so the operator sees whom they are about to bump BEFORE committing. It shares one core with `GET /booking-requests/:id`’s `conflicts`, so the two can never disagree about the same venue and the same hour, and it validates its spans with the SAME function `direct` uses, so a preflight that says "clean" predicts a submit that succeeds. ⚠️ ADVISORY: read outside any transaction and with NO advisory lock (locking a venue while somebody types would block every approval on it), so a disabled submit button is UX and the `direct` transaction refuses again. `venueIsOpen` is informational — a closed venue still accepts a direct booking. 🔴 Writes NOTHING, despite the verb.',
  })
  @ApiOkResponse({
    description: 'The conflict picture for these spans.',
    type: BookingPreflightResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or a span ends before it starts / starts in the past / overlaps another span of the same list — the same three refusals `direct` makes.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted venue.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  preflight(
    @Body() dto: BookingPreflightDto,
  ): Promise<BookingPreflightResponseDto> {
    return this.bookings.checkPreflight(dto);
  }

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'List booking requests — the approval queue.',
    description:
      'Filtered, sorted AND paginated entirely by the server. `counts` carries the five tab totals and is computed with `search` and `venueId` applied but WITHOUT `status`, so selecting a tab does not zero the other four. Every row carries ALL its slots, cancelled ones included, and a server-computed `isExpired` (`status = PENDING && lastEndAt < now`) — there is no fifth stored status and no cron.',
  })
  @ApiOkResponse({
    description: 'The page.',
    type: PaginatedBookingRequestsResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid query — an unknown `sort`, a `limit` outside 10/20/50, or an unrecognised parameter.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @Query() query: ListBookingRequestsQueryDto,
  ): Promise<PaginatedBookingRequestsResponseDto> {
    return this.bookings.list(query);
  }

  @Get(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'One booking request, with its conflict picture.',
    description:
      'Addressed by CUID only — the admin screen opens this from a row that already carries the id, unlike the LIFF detail which also accepts a `BR-…` code. Adds `venue.capacity`/`isOpen`, `createdBy`, `approvedBy`, `approvedAt` and `conflicts` to the list shape. ⚠️ `conflicts` is ADVISORY: it is read outside the deciding transaction and may be stale a second later, so a disabled confirm button is UX and never the boundary — the approval transaction refuses again.',
  })
  @ApiOkResponse({
    description: 'The booking request.',
    type: AdminBookingRequestDetailDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Unknown id.', type: ErrorResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  detail(@Param('id') id: string): Promise<AdminBookingRequestDetailDto> {
    return this.bookings.getDetail(id);
  }

  // `@HttpCode(200)` is MANDATORY on all three — Nest defaults POST to 201, which would claim a
  // resource was created. These three change the state of one that already exists.
  @Post(':id/approve')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'อนุมัติ — approve a pending request (ADR-001).',
    description:
      'NO BODY: any key at all is a 400, because there is nothing to say. One transaction sets this request APPROVED with `approvedById`/`approvedAt` and auto-rejects EVERY overlapping PENDING request, whose losers are collected BEFORE this request’s own status flips. `autoRejected` reports what actually happened, which can differ from the `conflicts.pendingLosers` the dialog showed if a new request arrived meanwhile. Overlapping an already-APPROVED slot is a hard 409 with NO write of any kind. The losers’ own slots are never touched — a rejected request stops occupying the calendar because the filter reads the parent’s status.',
  })
  @ApiOkResponse({ description: 'Approved.', type: ApproveBookingResponseDto })
  @ApiBadRequestResponse({
    description: 'A body was sent.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Unknown id.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'Not PENDING, every slot already cancelled, an overlap with an APPROVED slot, or two decisions on this venue collided.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  approve(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<ApproveBookingResponseDto> {
    return this.bookings.approve(id, { id: user.id, role: user.role });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'ปฏิเสธ — refuse a pending request, with a reason.',
    description:
      'The reason is MANDATORY and is trimmed before it is checked, so whitespace-only is a 400 — it is shown RAW to the requester in My Bookings and in LINE. Only a PENDING request may be rejected: an APPROVED one is a 409, and the way back from an approval is `cancel`. ⚠️ This touches NO slot row. "Refused" and "cancelled" are different facts, and writing `isCancelled` here would produce rows with a null `cancelledAt` that the schema calls corrupt.',
  })
  @ApiOkResponse({
    description: 'Rejected.',
    type: AdminBookingRequestDetailDto,
  })
  @ApiBadRequestResponse({
    description: 'Missing, blank or over-long reason, or an unknown key.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Unknown id.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'The request is not PENDING (an APPROVED one included).',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectBookingRequestDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminBookingRequestDetailDto> {
    return this.bookings.reject(id, dto, { id: user.id, role: user.role });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'ยกเลิก — cancel an approved booking, whole or by slot.',
    description:
      'Omit `slotIds` to cancel every live slot; supply them to drop only those days. The reason is mandatory either way. `firstStartAt`/`lastEndAt` are recomputed from the SURVIVING slots in the same transaction, and cancelling the last live slot turns the request CANCELLED (its span is then left as-is — the history list still needs a date to sort by). A cancelled span frees the room immediately, with nothing to invalidate. ⚠️ The `booking.cancel_lead_minutes` rule is NOT applied here: it governs what an END USER may do, and staff cancelling this afternoon’s event because a pipe burst is what this route is for.',
  })
  @ApiOkResponse({
    description: 'Cancelled.',
    type: AdminBookingRequestDetailDto,
  })
  @ApiBadRequestResponse({
    description:
      'Missing or blank reason, an empty/duplicated `slotIds`, or a slot id that belongs to another booking (refused, never skipped).',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Unknown id.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'The request is not APPROVED, every slot is already cancelled, or a named slot was cancelled already.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelBookingRequestDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AdminBookingRequestDetailDto> {
    return this.bookings.cancel(id, dto, { id: user.id, role: user.role });
  }
}
