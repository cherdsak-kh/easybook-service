import { ApiProperty } from '@nestjs/swagger';
import { DashboardFreeWindow, DashboardVenueState } from '../dashboard-rooms';

/**
 * design §2.3 — `GET /api/v1/dashboard/venues-live`. The two enums are the DOMAIN's, defined and
 * exported by `dashboard-rooms.ts` (the pure logic that decides them); this file only wires them
 * into Swagger.
 */
export { DashboardFreeWindow, DashboardVenueState };

export class DashboardCurrentSlotDto {
  @ApiProperty()
  slotId!: string;

  @ApiProperty()
  bookingRequestId!: string;

  @ApiProperty({ example: 'BR-25690920-002' })
  code!: string;

  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;

  @ApiProperty({
    description:
      'startAt is before today 00:00 Bangkok (cross-midnight marker, AC-D7).',
  })
  startsBeforeToday!: boolean;

  @ApiProperty({ description: 'endAt is after tomorrow 00:00 Bangkok.' })
  endsAfterToday!: boolean;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description:
      'round((serverTime − startAt) / (endAt − startAt) × 100), clamped to [0, 100]. The <progress> value.',
  })
  elapsedPercent!: number;

  @ApiProperty({
    minimum: 1,
    description:
      'ceil((endAt − serverTime) / 60000), floored at 1. "เหลืออีก …".',
  })
  remainingMinutes!: number;

  @ApiProperty()
  purpose!: string;

  @ApiProperty()
  attendees!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'requesterOf().name (D-18).',
  })
  requesterName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'requesterOf().departmentName (D-18).',
  })
  departmentName!: string | null;
}

export class DashboardNextSlotDto {
  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;

  @ApiProperty()
  endsAfterToday!: boolean;

  @ApiProperty()
  purpose!: string;
}

export class DashboardVenueDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ minimum: 1 })
  capacity!: number;

  @ApiProperty({ enum: DashboardVenueState, enumName: 'DashboardVenueState' })
  state!: DashboardVenueState;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Venue.closedReason, OFF only; null otherwise. Client falls back to "สถานที่นี้ปิดรับการจองชั่วคราว".',
  })
  closedReason!: string | null;

  @ApiProperty({
    minimum: 0,
    description:
      'APPROVED non-cancelled slots intersecting today at this venue ("จองวันนี้ N ช่วง"). Reported for OFF venues too, but the client prints "ไม่รับจองชั่วคราว" for them (AC-D11).',
  })
  todaySlotCount!: number;

  @ApiProperty({
    type: DashboardCurrentSlotDto,
    nullable: true,
    description: 'Non-null iff state = BUSY.',
  })
  current!: DashboardCurrentSlotDto | null;

  @ApiProperty({
    type: DashboardNextSlotDto,
    nullable: true,
    description:
      'First slot with serverTime < startAt < tomorrow 00:00 Bangkok. null when none, and always null for OFF.',
  })
  next!: DashboardNextSlotDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'FREE only: next.startAt, or null when free for the rest of the day.',
  })
  freeUntil!: Date | null;

  @ApiProperty({
    enum: DashboardFreeWindow,
    enumName: 'DashboardFreeWindow',
    nullable: true,
    description: 'FREE only; null for BUSY/OFF.',
  })
  freeWindow!: DashboardFreeWindow | null;
}

export class DashboardVenueCountsDto {
  @ApiProperty({ description: '= busy + free + off (AC-D10).' })
  all!: number;

  @ApiProperty()
  busy!: number;

  @ApiProperty()
  free!: number;

  @ApiProperty()
  off!: number;
}

export class DashboardVenuesLiveResponseDto {
  @ApiProperty({ format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ format: 'date', example: '2026-09-28' })
  today!: string;

  @ApiProperty({
    description:
      'Mon–Fri and 07:30 ≤ Bangkok HH:MM ≤ 16:30 (prototype bounds). Drives the D-3 subtitle.',
  })
  withinOperatingHours!: boolean;

  @ApiProperty({
    minimum: 0,
    description:
      'Card 3 value (D-4): Σ todaySlotCount over venues whose state ≠ OFF.',
  })
  todayBookings!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Card 3 desc N = counts.busy, computed in the same pass (AC-D3).',
  })
  inUseNow!: number;

  @ApiProperty({ type: DashboardVenueCountsDto })
  counts!: DashboardVenueCountsDto;

  @ApiProperty({
    type: [DashboardVenueDto],
    description:
      'Every non-deleted venue exactly once. Order: BUSY → FREE → OFF, then name (DB collation), then id.',
  })
  venues!: DashboardVenueDto[];
}
