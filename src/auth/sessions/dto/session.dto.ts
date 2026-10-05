import { ApiProperty } from '@nestjs/swagger';
import { DeviceInfoDto } from './device-info.dto';

export class SessionItemDto {
  @ApiProperty({
    example: 'kZ3v0Qx9yJb2Lw8Hn4Tq1A',
    minLength: 22,
    maxLength: 22,
    description:
      'Opaque handle for DELETE /auth/system/sessions/{handle}. NOT the session id and not usable as a cookie.',
  })
  handle!: string;

  @ApiProperty({ description: 'True only on `current`.' })
  isCurrent!: boolean;

  @ApiProperty({ type: DeviceInfoDto })
  device!: DeviceInfoDto;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '203.0.113.7',
    description:
      'IP at sign-in. NULL for a session created before this feature shipped.',
  })
  ipAddress!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Sign-in instant (session.createdAt).',
  })
  loginAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Last request made with this session (derived from the idle TTL, ±1 s). `now` for the current session.',
  })
  lastActiveAt!: string;
}

export class SessionListResponseDto {
  @ApiProperty({ type: SessionItemDto })
  current!: SessionItemDto;

  @ApiProperty({
    type: [SessionItemDto],
    description: 'Other live sessions, lastActiveAt DESC. May be empty.',
  })
  others!: SessionItemDto[];
}

export class RevokeSessionsResponseDto {
  @ApiProperty({
    example: 2,
    minimum: 0,
    description: 'Live sessions ended by this call.',
  })
  revoked!: number;
}
