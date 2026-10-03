import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
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
import { ReportCodedErrorDto } from '../reports/dto/report-error.dto';
import {
  IncidentCodedErrorDto,
  IncidentDetailDto,
  IncidentFilterDto,
  IncidentKpisResponseDto,
  IncidentListQueryDto,
  IncidentPageDto,
  IncidentRangeQueryDto,
} from './dto/incident.dto';
import { IncidentsService } from './incidents.service';

const BAD_REQUEST =
  'REPORT_DATE_INVALID / REPORT_RANGE_INVERTED / REPORT_RANGE_TOO_WIDE (coded), or an unknown or malformed query key (uncoded pipe body).';

/**
 * บันทึกข้อผิดพลาด (Hub 6) — `/api/v1/reports/error-log`. SUPER_ADMIN ONLY: ADMIN and VIEWER are 403 on
 * every route, `DELETE` included. Stack traces, IP addresses and user agents are visible to this role
 * alone (PDPA, plan §8).
 *
 * Declaration order is load-bearing: the static routes (`kpis`, `csv`, `detail/:id`) precede nothing
 * that could capture them, and no bare `:id` route exists, so `csv` and `kpis` can never be read as ids.
 */
@ApiTags('Reports')
@ApiCookieAuth('session')
@Controller('reports/error-log')
@UseGuards(SessionGuard, RolesGuard)
@Roles(SystemRole.SUPER_ADMIN)
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Hub 6 — the incident rows, newest first, server-paginated.',
    description:
      'Ranges include today (Bangkok days, <= 366 days). Search `q` is matched in memory over incident id, ' +
      'trace id, "<status> <method> <path>", message and component, so % and _ are literal. A page past the ' +
      'end is clamped. `purgeable` says how many incidents DELETE /reports/error-log would remove, and ' +
      '`retention` is the cap (the log is bounded, not permanent). The list holds no stack and no context.',
  })
  @ApiOkResponse({ type: IncidentPageDto })
  @ApiBadRequestResponse({
    description: BAD_REQUEST,
    type: ReportCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'ADMIN or VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(@Query() query: IncidentListQueryDto): Promise<IncidentPageDto> {
    return this.incidents.list(query);
  }

  @Get('kpis')
  @ApiOperation({
    summary:
      'Hub 6 — the four KPIs (range only, except the rolling 24 h count).',
    description:
      'availability.percent = 100 x (1 - 5xx / requests) over the range days from per-day counters (null when ' +
      'no request was counted); last24h is a rolling now - 24 h count independent of the range; the toolbar ' +
      'never changes any of them.',
  })
  @ApiOkResponse({ type: IncidentKpisResponseDto })
  @ApiBadRequestResponse({
    description: BAD_REQUEST,
    type: ReportCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'ADMIN or VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  kpis(
    @Query() query: IncidentRangeQueryDto,
  ): Promise<IncidentKpisResponseDto> {
    return this.incidents.kpis(query);
  }

  @Get('csv')
  @ApiOperation({
    summary: 'Hub 6 — every matching incident as a CSV download.',
    description:
      'The list filters minus paging. UTF-8 BOM, CRLF, RFC 4180, formula-neutralised. NO stack and NO context. ' +
      'File name `easybook-error-log_<startDate>_<endDate>.csv`.',
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
    description: 'ADMIN or VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  async csv(
    @Query() query: IncidentFilterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { fileName, body } = await this.incidents.csv(query);
    res.set(csvHeaders(fileName));
    return body;
  }

  @Get('detail/:id')
  @ApiOperation({
    summary:
      'Hub 6 — one incident with its stack trace and whitelisted context.',
    description:
      'The stack is frames only (<= 50 lines / 8 KB) and the context carries only whitelisted keys. 404 ' +
      '(INCIDENT_NOT_FOUND) for an unknown, malformed or evicted id alike.',
  })
  @ApiOkResponse({ type: IncidentDetailDto })
  @ApiNotFoundResponse({
    description: 'Unknown, malformed or no longer retained.',
    type: IncidentCodedErrorDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'ADMIN or VIEWER, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  detail(@Param('id') id: string): Promise<IncidentDetailDto> {
    return this.incidents.detail(id);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Hub 6 — purge incidents older than 30 days.',
    description:
      'Removes incidents older than the first Bangkok day of the 30 วันล่าสุด window. Idempotent: a second ' +
      'call removes nothing and still answers 204. Requires the x-csrf-token header like every unsafe verb. ' +
      'Automatic retention (5,000 entries / 90 days) is separate and still applies.',
  })
  @ApiNoContentResponse({ description: 'Purged (or nothing to purge).' })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'ADMIN or VIEWER, a missing or invalid CSRF token, or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  async purge(@CurrentUser() user: AuthenticatedSystemUser): Promise<void> {
    await this.incidents.purge(user.id);
  }
}
