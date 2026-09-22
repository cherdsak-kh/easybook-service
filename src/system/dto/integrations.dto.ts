import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { LineBotInfoDto } from '../../announcements/dto/line-bot-info.dto';

// ── Responses ──────────────────────────────────────────────────────────────

export class SwaggerStatusDto {
  @ApiProperty({
    description: 'Whether /docs and /docs-json are served right now.',
  })
  enabled!: boolean;
}

export class LineQuotaDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 500,
    description:
      "This month's push target limit; null when LINE reports no limit (`type: none`).",
  })
  total!: number | null;

  @ApiProperty({
    example: 44,
    description: 'Pushes counted against the quota this month.',
  })
  used!: number;
}

export class LineIntegrationDto {
  @ApiProperty({
    description:
      'A channel access token is loaded (a Messaging client exists).',
  })
  configured!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2006••••42',
    description:
      'Masked. null until a Channel ID is saved. The secret and token are never returned.',
  })
  channelId!: string | null;

  @ApiProperty({
    type: LineBotInfoDto,
    nullable: true,
    description:
      'From GET /v2/bot/info. null when unconfigured or when LINE did not answer.',
  })
  botInfo!: LineBotInfoDto | null;

  @ApiProperty({
    type: LineQuotaDto,
    nullable: true,
    description:
      'From the two quota reads. null when unconfigured or when LINE did not answer.',
  })
  quota!: LineQuotaDto | null;
}

export class StorageIntegrationDto {
  @ApiProperty({ description: 'All five R2_* variables are set.' })
  configured!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'easybook-dev' })
  bucket!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://pub-3f9a2c.r2.dev',
  })
  publicBaseUrl!: string | null;
}

export const DATABASE_HEALTH = ['ok', 'degraded', 'error'] as const;
export const REDIS_HEALTH = ['up', 'down'] as const;

export class DatabaseHealthDto {
  @ApiProperty({
    enum: DATABASE_HEALTH,
    enumName: 'DatabaseHealthStatus',
    description:
      '`ok` under 200 ms, `degraded` at or over 200 ms, `error` on failure or a 2 s timeout.',
  })
  status!: (typeof DATABASE_HEALTH)[number];

  @ApiProperty({ example: 2 })
  latencyMs!: number;
}

export class RedisHealthDto {
  @ApiProperty({ enum: REDIS_HEALTH, enumName: 'RedisHealthStatus' })
  status!: (typeof REDIS_HEALTH)[number];

  @ApiProperty({ example: 1 })
  latencyMs!: number;
}

export class InfrastructureHealthDto {
  @ApiProperty({ type: DatabaseHealthDto })
  database!: DatabaseHealthDto;

  @ApiProperty({ type: RedisHealthDto })
  redis!: RedisHealthDto;
}

export class SystemIntegrationsResponseDto {
  @ApiProperty({ type: SwaggerStatusDto })
  swagger!: SwaggerStatusDto;

  @ApiProperty({ type: LineIntegrationDto })
  line!: LineIntegrationDto;

  @ApiProperty({ type: StorageIntegrationDto })
  storage!: StorageIntegrationDto;

  @ApiProperty({ type: InfrastructureHealthDto })
  infrastructure!: InfrastructureHealthDto;
}

export class SetSwaggerResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  success!: true;

  @ApiProperty()
  enabled!: boolean;
}

export class UpdateLineIntegrationResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  success!: true;

  @ApiProperty({ type: String, nullable: true, example: '2006••••42' })
  maskedChannelId!: string | null;
}

export class LineVerifyResponseDto {
  @ApiProperty({
    type: Boolean,
    example: true,
    description: 'Always true on a 200 — a failed check is a 503.',
  })
  valid!: true;

  @ApiProperty({ type: LineBotInfoDto })
  botInfo!: LineBotInfoDto;

  @ApiProperty({ type: LineQuotaDto })
  quota!: LineQuotaDto;
}

export class StorageProbeResponseDto {
  @ApiProperty({ description: '`read && write`.' })
  ok!: boolean;

  @ApiProperty({
    example: 48,
    description: 'Whole probe, milliseconds. 0 when unconfigured.',
  })
  latencyMs!: number;

  @ApiProperty({ description: 'ListObjectsV2 (one key) succeeded.' })
  read!: boolean;

  @ApiProperty({
    description: 'A two-byte PutObject + DeleteObject succeeded.',
  })
  write!: boolean;
}

// ── Requests ───────────────────────────────────────────────────────────────

export class SetSwaggerDto {
  @ApiProperty({ description: 'A JSON boolean — the string "true" is a 400.' })
  @IsBoolean()
  enabled!: boolean;
}

/**
 * Every field optional; at least one is required (checked in the service — 400 `LINE_UPDATE_EMPTY`).
 * "Blank = keep" is the FORM's convention: the client omits a field it does not change. An empty
 * string here is a 400, never "clear the value".
 */
export class UpdateLineIntegrationDto {
  @ApiProperty({
    required: false,
    example: '2006123442',
    description: 'Exactly 10 digits.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{10}$/, { message: 'channelId must be exactly 10 digits' })
  channelId?: string;

  @ApiProperty({ required: false, description: '32 hexadecimal characters.' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{32}$/i, {
    message: 'channelSecret must be 32 hexadecimal characters',
  })
  channelSecret?: string;

  @ApiProperty({
    required: false,
    description: '40–1000 characters, no whitespace.',
  })
  @IsOptional()
  @IsString()
  @Length(40, 1000)
  @Matches(/^\S+$/, {
    message: 'channelAccessToken must not contain whitespace',
  })
  channelAccessToken?: string;
}

/** Codes this surface adds to the house error body. */
export const INTEGRATION_ERROR_CODES = [
  'LINE_UPDATE_EMPTY',
  'LINE_NOT_CONFIGURED',
  'LINE_UNAVAILABLE',
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export class IntegrationCodedErrorDto {
  @ApiProperty({ example: 503 })
  statusCode!: number;

  @ApiProperty({ example: 'Service Unavailable' })
  error!: string;

  @ApiProperty({ example: 'ยังไม่ได้ตั้งค่า LINE หรือ Token ไม่ถูกต้อง' })
  message!: string;

  @ApiProperty({
    enum: INTEGRATION_ERROR_CODES,
    enumName: 'IntegrationErrorCode',
  })
  code!: IntegrationErrorCode;
}
