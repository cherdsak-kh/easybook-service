import { BadRequestException } from '@nestjs/common';

/**
 * Hub 4 (ส่งออกรายงานราชการ) constants. One file, per the house convention.
 */

/** Safety valve (design §2.3.1 row 8): never a silent truncation of an official document. */
export const REPORT_DOCUMENT_MAX_ROWS = 20_000;

export const REPORT_EXPORT_ERROR_CODES = [
  'REPORT_DATE_INVALID',
  'REPORT_RANGE_INVERTED',
  'REPORT_RANGE_TOO_WIDE',
  'REPORT_PERIOD_MISMATCH',
  'REPORT_VENUE_INVALID',
  'REPORT_DEPARTMENT_INVALID',
  'REPORT_DOCUMENT_TOO_LARGE',
] as const;
export type ReportExportErrorCode = (typeof REPORT_EXPORT_ERROR_CODES)[number];

export const REPORT_PERIOD_MISMATCH_MESSAGE =
  'startDate and endDate must be the exact bounds of the selected term or month.';
export const REPORT_DOCUMENT_TOO_LARGE_MESSAGE = `The document would exceed ${REPORT_DOCUMENT_MAX_ROWS} rows; choose a narrower range or scope.`;

/** Fixed official text, verbatim from the prototype. */
export const REPORT_SCHOOL_LINE =
  'โรงเรียนเทศบาลท่าโขลง 1 สังกัดเทศบาลเมืองท่าโขลง จังหวัดปทุมธานี';

export const REPORT_NO_BUCKET_LABEL = 'ไม่ระบุกลุ่ม/ฝ่าย';
export const REPORT_EMPTY_TABLE_TEXT = 'ไม่มีรายการในช่วงเวลาและขอบเขตที่เลือก';
export const REPORT_XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Same body shape as Phase 1's `codedError` (`{ statusCode, message, error, code }`), for the Hub 4 code set. */
export function exportCodedError(
  code: ReportExportErrorCode,
  message: string,
): BadRequestException {
  const base = new BadRequestException(message).getResponse() as Record<
    string,
    unknown
  >;
  return new BadRequestException({ ...base, code });
}
