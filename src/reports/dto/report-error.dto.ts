import { ApiProperty } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { REPORT_ERROR_CODES, type ReportErrorCode } from '../reports.constants';

/**
 * `GET /reports/overview`'s coded 400 body (design §2.5, AC-R15). ONE stable code per validation
 * condition — a malformed date, an inverted range, a range over 366 days, an unknown venue, or an
 * unknown/reserved department — so the client can branch without parsing English prose. Built with
 * the same `codedError()` shape `IntegrationsService` already uses.
 *
 * ⚠️ NOT every 400 on this endpoint carries a `code`: `forbidNonWhitelisted` and a missing/malformed
 * `departmentId` are the Nest pipe's own house body (`ErrorResponseDto`, no `code`) — see the design's
 * validation table, row #1.
 */
export class ReportCodedErrorDto extends ErrorResponseDto {
  @ApiProperty({ enum: REPORT_ERROR_CODES, enumName: 'ReportErrorCode' })
  code!: ReportErrorCode;
}
