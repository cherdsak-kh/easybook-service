import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import {
  SUPPORT_CATEGORIES,
  SUPPORT_DESCRIPTION_MAX,
  SUPPORT_DIAGNOSTICS_MAX,
  SUPPORT_ERROR_CODES,
  SUPPORT_PATH_MAX,
  SUPPORT_SEVERITIES,
  type SupportCategory,
  type SupportErrorCode,
  type SupportSeverity,
} from '../support.constants';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** The `@Body()` — validated by the global pipe (whitelist + forbidNonWhitelisted). */
export class SupportIncidentDto {
  @ApiProperty({
    enum: SUPPORT_CATEGORIES,
    enumName: 'SupportIncidentCategory',
    example: 'web',
  })
  @IsIn(SUPPORT_CATEGORIES)
  category!: SupportCategory;

  @ApiProperty({
    enum: SUPPORT_SEVERITIES,
    enumName: 'SupportIncidentSeverity',
    example: 'normal',
  })
  @IsIn(SUPPORT_SEVERITIES)
  severity!: SupportSeverity;

  @ApiProperty({
    maxLength: SUPPORT_PATH_MAX,
    example: '/backend/bookings/requests',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_PATH_MAX)
  path!: string;

  @ApiProperty({
    maxLength: SUPPORT_DESCRIPTION_MAX,
    description: 'Counted after trimming. Refused, never truncated.',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_DESCRIPTION_MAX)
  description!: string;

  @ApiPropertyOptional({
    maxLength: SUPPORT_DIAGNOSTICS_MAX,
    description:
      'Client-built, informational only. Never trusted for the reporter role.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SUPPORT_DIAGNOSTICS_MAX)
  diagnostics?: string;
}

/** Swagger-only: the multipart body as the client sends it. NEVER used as `@Body()`. */
export class SupportIncidentFormDto extends SupportIncidentDto {
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string', format: 'binary' },
    maxItems: 3,
    description:
      '0–3 parts, each named `files`. PNG, JPEG or WEBP by content. ≤ 5 MB each; ≤ 9.5 MB combined.',
  })
  files?: string[];
}

export class SupportIncidentResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  success!: true;

  @ApiProperty({
    example: 'INC-1043',
    description:
      'Server-minted. Identical to the code in the Discord message heading.',
  })
  code!: string;

  @ApiProperty({
    example: '2026-10-05T15:31:07.000Z',
    description: 'ISO 8601 UTC. Same instant as the Discord message timestamp.',
  })
  timestamp!: string;
}

export { SUPPORT_ERROR_CODES };

export class SupportCodedErrorDto extends ErrorResponseDto {
  @ApiProperty({ enum: SUPPORT_ERROR_CODES, enumName: 'SupportErrorCode' })
  code!: SupportErrorCode;
}
