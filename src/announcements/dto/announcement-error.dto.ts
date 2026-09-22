import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';

/**
 * Every `code` the send and bot-info routes answer with (`ANNOUNCE-API-2`, design S-6).
 *
 * Phase 1's routes keep their code-less bodies; pipe, guard and CSRF errors (401/403) on these two
 * routes are the house body without `code` too.
 */
export const ANNOUNCEMENT_ERROR_CODES = [
  'ANNOUNCEMENT_NOT_FOUND',
  'ANNOUNCEMENT_ALREADY_SENT',
  'ANNOUNCEMENT_SEND_IN_PROGRESS',
  'ANNOUNCEMENT_BODY_REQUIRED',
  'ANNOUNCEMENT_DEPARTMENT_INVALID',
  'NO_RECIPIENTS_FOUND',
  'ANNOUNCEMENT_PARTIALLY_SENT',
  'LINE_SEND_FAILED',
  'LINE_NOT_CONFIGURED',
  'LINE_RATE_LIMITED',
  'LINE_BOT_INFO_UNAVAILABLE',
] as const;

export type AnnouncementErrorCode = (typeof ANNOUNCEMENT_ERROR_CODES)[number];

/**
 * The house error body plus a machine-readable `code` — ONE schema for every coded error on the two
 * routes, because Swagger allows one type per status and 502 carries two shapes. `message` stays a
 * human English constant; switch on `code`.
 */
export class AnnouncementCodedErrorDto extends ErrorResponseDto {
  @ApiProperty({
    enum: ANNOUNCEMENT_ERROR_CODES,
    enumName: 'AnnouncementErrorCode',
    example: 'ANNOUNCEMENT_ALREADY_SENT',
  })
  code!: AnnouncementErrorCode;

  @ApiPropertyOptional({
    example: 500,
    minimum: 0,
    description:
      'Present iff `code` is `ANNOUNCEMENT_PARTIALLY_SENT`: recipients whose chunk LINE accepted — what `sentCount` now holds.',
  })
  acceptedCount?: number;

  @ApiPropertyOptional({
    example: 734,
    minimum: 0,
    description:
      'Present iff `code` is `ANNOUNCEMENT_PARTIALLY_SENT`: recipients the send targeted.',
  })
  targetedCount?: number;
}
