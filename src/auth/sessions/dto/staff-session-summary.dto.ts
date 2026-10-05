import { ApiProperty } from '@nestjs/swagger';
import { DeviceInfoDto } from './device-info.dto';

export class LastLoginDto {
  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;

  @ApiProperty({
    type: DeviceInfoDto,
    nullable: true,
    description:
      'NULL when the login predates the 90-day history (time comes from SystemUser.lastLoginAt).',
  })
  device!: DeviceInfoDto | null;

  @ApiProperty({ type: String, nullable: true })
  ipAddress!: string | null;
}

export class StaffSessionSummaryDto {
  @ApiProperty({
    example: 2,
    minimum: 0,
    description: 'Live sessions. Always 0 for a suspended account.',
  })
  activeSessionCount!: number;

  @ApiProperty({
    type: LastLoginDto,
    nullable: true,
    description: 'NULL = never signed in (ยังไม่เคยเข้าสู่ระบบ).',
  })
  lastLogin!: LastLoginDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Latest FORCE_REVOKED within 90 days. The actor is never returned.',
  })
  lastForceRevokedAt!: string | null;
}
