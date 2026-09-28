import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedSystemUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import type { Actor } from '../system-users/system-users.policy';
import { ReportsOverviewQueryDto } from './dto/reports-overview-query.dto';
import { ReportCodedErrorDto } from './dto/report-error.dto';
import { ReportsOverviewResponseDto } from './dto/reports-overview-response.dto';
import { ReportsService } from './reports.service';

/**
 * Mirrors `departments.controller.ts`'s helper (same reasoning: `system-users.policy.ts` is a plain
 * module of pure functions with no Nest DI, so a small local copy costs less than the import).
 */
const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
  createdById: user.createdBy?.id ?? null,
});

/**
 * ภาพรวมสถิติเชิงบริหาร (Hub 1) — route prefix `/api/v1/reports` (design §2.5).
 *
 * Stateless: every figure is derived fresh from `startDate`/`endDate`[`/venueId`][`/departmentId`],
 * never cached (design §2.1 — the key family is not enumerable, so it could never be invalidated by a
 * booking write). All three roles may read (D-15); nothing here writes.
 */
@ApiTags('Reports')
@ApiCookieAuth('session')
@Controller('reports')
@UseGuards(SessionGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'Hub 1 — range-filtered KPIs, trend and top venues.',
    description:
      'startDate/endDate are Bangkok calendar dates (YYYY-MM-DD), inclusive, span ≤ 366 days (D-14). ' +
      'venueId/departmentId are optional filters; an unknown or (for a non-SUPER_ADMIN) reserved id is ' +
      'a coded 400 — the same body for both (no existence oracle, AC-R15). Data is attributed by each ' +
      "request's firstStartAt Bangkok date and stops at yesterday (D-10) — the current term therefore " +
      'reads "to date". pendingBacklog ignores every filter (AC-R8).',
  })
  @ApiOkResponse({ type: ReportsOverviewResponseDto })
  @ApiBadRequestResponse({
    description:
      'A malformed date, startDate > endDate, a range over 366 days, an unknown venueId, an unknown/' +
      'reserved departmentId (REPORT_* coded body), or an unknown query key (uncoded pipe body).',
    type: ReportCodedErrorDto,
  })
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
  getOverview(
    @Query() query: ReportsOverviewQueryDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<ReportsOverviewResponseDto> {
    return this.reports.getOverview(query, actorOf(user));
  }
}
