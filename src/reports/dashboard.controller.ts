import { Controller, Get, UseGuards } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { DashboardService } from './dashboard.service';
import { DashboardVenuesLiveResponseDto } from './dto/dashboard-venues-live.dto';
import { DashboardVitalsResponseDto } from './dto/dashboard-vitals.dto';

/**
 * ภาพรวมระบบ (Hub 7) — route prefix `/api/v1/dashboard` (design §2.0–§2.3).
 *
 * ⚠️ SPLIT INTO TWO GETs, NOT ONE `summary` (DV-1). `venues-live` can be a few indexed queries over
 * every slot touching today, while `vitals` is two counts and a `LIMIT 4`; keeping them separate lets
 * the client fail and retry each independently (AC-D22) and keeps card 3's number and the room tabs'
 * count coming from exactly ONE pass (AC-D3) rather than two endpoints that could disagree at a slot
 * boundary.
 *
 * All three roles may read (D-15): a supervisor is expected to see this screen. Nothing here writes —
 * อนุมัติ and จองห้องนี้ทันที stay on the EXISTING `booking-requests` endpoints, so ADR-001 runs in
 * exactly one place.
 */
@ApiTags('Dashboard')
@ApiCookieAuth('session')
@Controller('dashboard')
@UseGuards(SessionGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('vitals')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'Hub 7 vital cards 1–2 and the pending queue.',
    description:
      'AC-D1/AC-D2: PENDING request count and PENDING LINE-user count. AC-D12: the first 4 PENDING requests in D-6 order (firstStartAt asc, createdAt asc, code asc), plus the full total. One `serverTime` for the whole response (D-2) — the client never recomputes anything from the device clock.',
  })
  @ApiOkResponse({ type: DashboardVitalsResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'CSRF failure (n/a on GET), or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  getVitals(): Promise<DashboardVitalsResponseDto> {
    return this.dashboard.getVitals();
  }

  @Get('venues-live')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'Hub 7 room occupancy grid, tab counts, and vital card 3.',
    description:
      "AC-D3, AC-D6–AC-D11: every non-deleted venue exactly once, each BUSY/FREE/OFF at `serverTime` (D-2). A venue with `isOpen = false` is OFF even with an approved slot covering now (D-5, OQ-3). `todayBookings`/`inUseNow` are card 3's value/desc, computed in the SAME pass as the tab counts so the two can never disagree (AC-D3, DV-1).",
  })
  @ApiOkResponse({ type: DashboardVenuesLiveResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'CSRF failure (n/a on GET), or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  getVenuesLive(): Promise<DashboardVenuesLiveResponseDto> {
    return this.dashboard.getVenuesLive();
  }
}
