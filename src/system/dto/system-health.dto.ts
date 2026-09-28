import { ApiProperty } from '@nestjs/swagger';

/** design §2.4 — `GET /api/v1/system/health`. */

export enum HealthServiceStatus {
  UP = 'UP',
  DOWN = 'DOWN',
  /** No LINE token / no R2 config (dev). Never `database` — the DB is always configured. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
}

export enum HealthOverall {
  OK = 'OK',
  /** Any service is DOWN. `NOT_CONFIGURED` never degrades the overall status (D-8). */
  DEGRADED = 'DEGRADED',
}

export enum HealthDetail {
  /** SUPER_ADMIN — `telemetry` is populated. */
  FULL = 'FULL',
  /** ADMIN / VIEWER — `telemetry` is `null`; the server never builds the numbers (AC-D17). */
  SUMMARY = 'SUMMARY',
}

export class HealthServiceSummaryDto {
  @ApiProperty({ enum: HealthServiceStatus, enumName: 'HealthServiceStatus' })
  status!: HealthServiceStatus;
}

export class HealthServicesDto {
  @ApiProperty({
    type: HealthServiceSummaryDto,
    description: 'Never NOT_CONFIGURED — the DB is always configured.',
  })
  database!: HealthServiceSummaryDto;

  @ApiProperty({ type: HealthServiceSummaryDto })
  line!: HealthServiceSummaryDto;

  @ApiProperty({ type: HealthServiceSummaryDto })
  storage!: HealthServiceSummaryDto;
}

export class DatabaseTelemetryDto {
  @ApiProperty({
    minimum: 0,
    description:
      'SELECT 1 round trip, ms (D-8 fallback — the adapter does not expose pool active/max, OQ-A3).',
  })
  latencyMs!: number;
}

export class LineTelemetryDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Monthly push limit; null = unlimited or unknown.',
  })
  quotaTotal!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  quotaUsed!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'max(0, total − used); null when total is null or the probe failed. "โควตาเหลือ N ข้อความ".',
  })
  quotaRemaining!: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When LINE was actually called (cache age). null when NOT_CONFIGURED.',
  })
  observedAt!: Date | null;
}

export class StorageTelemetryDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Read-only ListObjectsV2 latency, ms; null when NOT_CONFIGURED.',
  })
  latencyMs!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  observedAt!: Date | null;
}

export class SystemHealthTelemetryDto {
  @ApiProperty({ type: DatabaseTelemetryDto })
  database!: DatabaseTelemetryDto;

  @ApiProperty({ type: LineTelemetryDto })
  line!: LineTelemetryDto;

  @ApiProperty({ type: StorageTelemetryDto })
  storage!: StorageTelemetryDto;
}

export class SystemHealthResponseDto {
  @ApiProperty({ format: 'date-time' })
  checkedAt!: Date;

  @ApiProperty({
    enum: HealthOverall,
    enumName: 'HealthOverall',
    description:
      'DEGRADED iff any service is DOWN. NOT_CONFIGURED never degrades (D-8).',
  })
  overall!: HealthOverall;

  @ApiProperty({
    enum: HealthDetail,
    enumName: 'HealthDetail',
    description: 'FULL for SUPER_ADMIN, SUMMARY for ADMIN and VIEWER.',
  })
  detail!: HealthDetail;

  @ApiProperty({ type: HealthServicesDto })
  services!: HealthServicesDto;

  @ApiProperty({
    type: SystemHealthTelemetryDto,
    nullable: true,
    description:
      'null unless detail = FULL. The server never computes these numbers into an ADMIN/VIEWER body (AC-D17).',
  })
  telemetry!: SystemHealthTelemetryDto | null;
}
