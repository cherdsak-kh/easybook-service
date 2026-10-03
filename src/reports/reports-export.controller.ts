import {
  Controller,
  Get,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
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
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import type { Actor } from '../system-users/system-users.policy';
import { ReportExportCodedErrorDto } from './dto/report-export-error.dto';
import {
  ReportDocumentDto,
  ReportScopeOptionsDto,
} from './dto/report-document.dto';
import { ReportsExportQueryDto } from './dto/reports-export-query.dto';
import { REPORT_XLSX_MIME } from './report-export.constants';
import { writeReportXlsx } from './report-xlsx';
import { ReportsExportService } from './reports-export.service';

const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
  createdById: user.createdBy?.id ?? null,
});

/**
 * ศูนย์ส่งออกรายงานราชการ (Hub 4) — `/api/v1/reports/export`. SUPER_ADMIN and ADMIN only (a VIEWER is
 * 403 on every route here). One builder feeds both outputs: `GET /reports/export` returns the document
 * model the A4 sheet is painted from, and `GET /reports/export/xlsx` serialises the SAME model.
 *
 * Static routes (`xlsx`, `scope-options`) sit beside the bare `GET /` and no param route exists, so
 * nothing can be captured as an id.
 */
@ApiTags('Reports')
@ApiCookieAuth('session')
@Controller('reports/export')
@UseGuards(SessionGuard, RolesGuard)
@Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
export class ReportsExportController {
  constructor(private readonly exports: ReportsExportService) {}

  @Get()
  @ApiOperation({
    summary: 'Hub 4 — the official report as a document model (JSON).',
    description:
      'template (SUMMARY | LEDGER | VENUES), period (TERM | MONTH | CUSTOM) and startDate/endDate are required; ' +
      'venueId/departmentId narrow the scope. Figures come from the same fold as Hubs 1 to 3, so an unscoped ' +
      'SUMMARY quotes /reports/overview and /reports/operations exactly. Dates are Buddhist-era `วว ด.ด. ปปปป`, ' +
      'times `HH.MM น.`. No requester name, phone, e-mail or LINE id appears anywhere (AC-E7). Data stops at ' +
      'yesterday (P1 D-10).',
  })
  @ApiOkResponse({ type: ReportDocumentDto })
  @ApiBadRequestResponse({
    description:
      'REPORT_DATE_INVALID / REPORT_RANGE_INVERTED / REPORT_RANGE_TOO_WIDE / REPORT_PERIOD_MISMATCH / ' +
      'REPORT_VENUE_INVALID / REPORT_DEPARTMENT_INVALID / REPORT_DOCUMENT_TOO_LARGE (coded), or a missing or ' +
      'unknown query key (uncoded pipe body).',
    type: ReportExportCodedErrorDto,
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
  getDocument(
    @Query() query: ReportsExportQueryDto,
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<ReportDocumentDto> {
    return this.exports.build(query, actorOf(user));
  }

  @Get('xlsx')
  @ApiOperation({
    summary: 'Hub 4 — the same document as an .xlsx workbook (download).',
    description:
      'Numbers are numeric cells; every other cell is a STRING cell, never a formula, so a purpose such as ' +
      '`=HYPERLINK(...)` stays inert text. `Content-Disposition: attachment; filename="easybook-report-<template>_<startDate>_<endDate>.xlsx"`.',
  })
  @ApiProduces(REPORT_XLSX_MIME)
  @ApiOkResponse({
    description: 'The workbook.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiBadRequestResponse({
    description:
      'As GET /reports/export (a JSON body: errors are raised before any byte is written).',
    type: ReportExportCodedErrorDto,
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
  async getXlsx(
    @Query() query: ReportsExportQueryDto,
    @CurrentUser() user: AuthenticatedSystemUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const doc = await this.exports.build(query, actorOf(user));
    const buffer = await writeReportXlsx(doc);
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(buffer, {
      type: REPORT_XLSX_MIME,
      disposition: `attachment; filename="${doc.fileName}"`,
    });
  }

  @Get('scope-options')
  @ApiOperation({
    summary: 'Hub 4 — the venue and department choices for the scope selects.',
    description:
      'Every venue (soft-deleted included, flagged) and every department. The system-reserved department is ' +
      'OMITTED for ADMIN (P2 D-20). No counts and no PII.',
  })
  @ApiOkResponse({ type: ReportScopeOptionsDto })
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
  getScopeOptions(
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<ReportScopeOptionsDto> {
    return this.exports.scopeOptions(actorOf(user));
  }
}
