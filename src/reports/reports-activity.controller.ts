import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthenticatedSystemUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { csvHeaders } from '../common/csv.util';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import type { Actor } from '../system-users/system-users.policy';
import {
  AuditActorsResponseDto,
  AuditKpisResponseDto,
  AuditPageDto,
} from './dto/audit.dto';
import { ReportCodedErrorDto } from './dto/report-error.dto';
import {
  ReportsActivityFilterDto,
  ReportsActivityQueryDto,
} from './dto/reports-activity-query.dto';
import { ReportsRangeQueryDto } from './dto/reports-range-query.dto';
import { ReportsActivityService } from './reports-activity.service';

const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
  createdById: user.createdBy?.id ?? null,
});

const BAD_REQUEST =
  'REPORT_DATE_INVALID / REPORT_RANGE_INVERTED / REPORT_RANGE_TOO_WIDE (coded), or an unknown or malformed query key (uncoded pipe body).';

/**
 * ประวัติการทำรายการ (Hub 5) — `/api/v1/reports/activity`. SUPER_ADMIN and ADMIN only (a VIEWER is 403
 * on every route). Staff actions only: system automation (auto-reject, expiry) and LIFF self-cancels
 * are excluded (D-15). No audit table exists (PO ruling OQ-P3-1), so events are SYNTHESISED; see
 * `capabilities` on the page response for what the source can and cannot supply.
 *
 * KPIs and actor options are separate routes over the same internals as the list, so the toolbar
 * (`action`/`actorId`/`q`, list and CSV only) can never change them.
 */
@ApiTags('Reports')
@ApiCookieAuth('session')
@Controller('reports/activity')
@UseGuards(SessionGuard, RolesGuard)
@Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
export class ReportsActivityController {
  constructor(private readonly activity: ReportsActivityService) {}

  @Get()
  @ApiOperation({
    summary: 'Hub 5 — the staff activity rows, newest first, server-paginated.',
    description:
      'startDate/endDate are Bangkok dates, inclusive, TODAY INCLUDED, span <= 366 days. Events are filtered ' +
      'by their own timestamp. `action`, `actorId` and `q` narrow the rows only. `limit` is 10, 20 or 50; a ' +
      'page past the end is clamped (the response echoes the page used). `at` is exact except for REJECT ' +
      '(`atIsApproximate`: the reject writes no time of its own). `actor` is null where the source records ' +
      'none. Actor and target departments of a system-reserved department fold to null for ADMIN (P2 D-20).',
  })
  @ApiOkResponse({ type: AuditPageDto })
  @ApiBadRequestResponse({
    description: BAD_REQUEST,
    type: ReportCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'A VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @Query() query: ReportsActivityQueryDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AuditPageDto> {
    return this.activity.list(query, actorOf(user));
  }

  @Get('kpis')
  @ApiOperation({
    summary: 'Hub 5 — the four KPIs of the range (range only).',
    description:
      'Dates only: the KPIs follow the range and never the toolbar. `resourceChanges` is null while the ' +
      'source records no venue changes. `topActor` considers named actors only.',
  })
  @ApiOkResponse({ type: AuditKpisResponseDto })
  @ApiBadRequestResponse({
    description: BAD_REQUEST,
    type: ReportCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'A VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  kpis(
    @Query() query: ReportsRangeQueryDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AuditKpisResponseDto> {
    return this.activity.kpis(query, actorOf(user));
  }

  @Get('actors')
  @ApiOperation({
    summary: 'Hub 5 — the staff choices for the actor select.',
    description:
      'Staff with at least one named event in the range, Thai-sorted, soft-deleted flagged. Dates only.',
  })
  @ApiOkResponse({ type: AuditActorsResponseDto })
  @ApiBadRequestResponse({
    description: BAD_REQUEST,
    type: ReportCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'A VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  actors(
    @Query() query: ReportsRangeQueryDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<AuditActorsResponseDto> {
    return this.activity.actors(query, actorOf(user));
  }

  @Get('csv')
  @ApiOperation({
    summary: 'Hub 5 — every matching row as a CSV download.',
    description:
      'The same filters as the list, minus paging: EVERY filtered row, not the page. UTF-8 BOM, CRLF, RFC 4180 ' +
      'quoting; a cell beginning with = + - @ (or a tab/CR) is prefixed with an apostrophe. File name ' +
      '`easybook-audit_<startDate>_<endDate>.csv`.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV.', schema: { type: 'string' } })
  @ApiBadRequestResponse({
    description: BAD_REQUEST,
    type: ReportCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'A VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  async csv(
    @Query() query: ReportsActivityFilterDto,
    @CurrentUser() user: AuthenticatedSystemUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { fileName, body } = await this.activity.csv(query, actorOf(user));
    res.set(csvHeaders(fileName));
    return body;
  }
}
