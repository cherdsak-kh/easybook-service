import { ApiProperty } from '@nestjs/swagger';
import {
  DEVICE_TYPES,
  UA_BROWSERS,
  UA_OS,
  type DeviceType,
  type UaBrowser,
  type UaOs,
} from '../sessions.constants';

/** ONE schema, reused by the session list, the login history and the staff summary. */
export class DeviceInfoDto {
  @ApiProperty({
    enum: DEVICE_TYPES,
    enumName: 'DeviceType',
    example: 'desktop',
  })
  deviceType!: DeviceType;

  @ApiProperty({
    enum: UA_OS,
    enumName: 'UaOs',
    nullable: true,
    example: 'Windows',
  })
  os!: UaOs | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '17',
    description:
      'Major version only. NULL when the UA cannot tell (Windows 10 vs 11, macOS, Chrome-reduced Android).',
  })
  osVersion!: string | null;

  @ApiProperty({
    enum: UA_BROWSERS,
    enumName: 'UaBrowser',
    nullable: true,
    example: 'Chrome',
  })
  browser!: UaBrowser | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '128',
    description: 'Major version only.',
  })
  browserVersion!: string | null;
}
