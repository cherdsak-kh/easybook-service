import { ApiProperty } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import {
  REPORT_EXPORT_ERROR_CODES,
  type ReportExportErrorCode,
} from '../report-export.constants';

/**
 * The coded 400 of the Hub 4 endpoints. A NEW enum on purpose: `ReportCodedErrorDto` / `ReportErrorCode`
 * (Phase 1) stay byte-identical in the OpenAPI schema.
 */
export class ReportExportCodedErrorDto extends ErrorResponseDto {
  @ApiProperty({
    enum: REPORT_EXPORT_ERROR_CODES,
    enumName: 'ReportExportErrorCode',
  })
  code!: ReportExportErrorCode;
}
