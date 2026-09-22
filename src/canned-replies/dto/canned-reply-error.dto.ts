import { ApiProperty } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';

/**
 * Every `code` the canned-replies service answers with (ANNOUNCE-API-5, D-5).
 *
 * Pipe, guard and CSRF errors (400 `string[]` / 401 / 403) are the house body WITHOUT `code`.
 */
export const CANNED_REPLY_ERROR_CODES = [
  'CANNED_REPLIES_LIMIT_EXCEEDED',
  'CANNED_REPLY_NOT_FOUND',
  'CANNED_REPLY_UPDATE_EMPTY',
] as const;

export type CannedReplyErrorCode = (typeof CANNED_REPLY_ERROR_CODES)[number];

/**
 * The house error body plus a machine-readable `code`. `message` is one string (Thai for the limit,
 * English otherwise); switch on `code`, never on `message`.
 */
export class CannedReplyCodedErrorDto extends ErrorResponseDto {
  @ApiProperty({
    enum: CANNED_REPLY_ERROR_CODES,
    enumName: 'CannedReplyErrorCode',
    example: 'CANNED_REPLIES_LIMIT_EXCEEDED',
  })
  code!: CannedReplyErrorCode;
}
