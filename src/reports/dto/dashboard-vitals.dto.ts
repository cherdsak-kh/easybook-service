import { ApiProperty } from '@nestjs/swagger';

/** design §2.2 — `GET /api/v1/dashboard/vitals`. */

export class DashboardQueueVenueDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'หอประชุมวารณ' })
  name!: string;

  @ApiProperty({
    description:
      'Venue is soft-deleted; the client appends "(ลบแล้ว)" (E-8). History is never hidden.',
  })
  isDeleted!: boolean;
}

export class DashboardSlotSpanDto {
  @ApiProperty({ format: 'date-time' })
  startAt!: Date;

  @ApiProperty({ format: 'date-time' })
  endAt!: Date;
}

export class DashboardPendingItemDto {
  @ApiProperty({
    description:
      'cuid — passed straight to the existing detail/approve dialogs.',
  })
  id!: string;

  @ApiProperty({ example: 'BR-25690926-004' })
  code!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'requesterOf().name (D-18). null → the client prints "ไม่ระบุ".',
  })
  requesterName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'requesterOf().departmentName (D-18). null → "ไม่ระบุ".',
  })
  departmentName!: string | null;

  @ApiProperty({ type: DashboardQueueVenueDto })
  venue!: DashboardQueueVenueDto;

  @ApiProperty()
  purpose!: string;

  @ApiProperty({
    type: DashboardSlotSpanDto,
    description:
      'The earliest NON-cancelled slot (falls back to the earliest slot if every slot is cancelled, which a PENDING row should never have).',
  })
  firstSlot!: DashboardSlotSpanDto;

  @ApiProperty({
    minimum: 1,
    description:
      'Count of non-cancelled slots. The client shows "(รวม N ช่วงเวลา)" only when this is > 1.',
  })
  activeSlotCount!: number;

  @ApiProperty({
    example: 1,
    description:
      "Bangkok calendar days from today to firstSlot.startAt's Bangkok date. <0 overdue, 0 today, 1 tomorrow (D-6 badge rule).",
  })
  dayOffset!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class DashboardVitalsResponseDto {
  @ApiProperty({
    format: 'date-time',
    description:
      'The one instant every figure in this response was read at (D-2).',
  })
  serverTime!: Date;

  @ApiProperty({
    format: 'date',
    example: '2026-09-28',
    description: 'Bangkok calendar date of serverTime.',
  })
  today!: string;

  @ApiProperty({
    minimum: 0,
    description:
      'count(BookingRequest status=PENDING) — AC-D1. Also the queue heading N and the คำขอจองสถานที่ nav badge.',
  })
  pendingRequests!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'count(LineUser access=PENDING, deletedAt=null) — AC-D2, same where as the nav badge.',
  })
  pendingLineUsers!: number;

  @ApiProperty({
    type: [DashboardPendingItemDto],
    maxItems: 4,
    description:
      'D-6 order: firstStartAt asc, then createdAt asc, then code asc. Top 4 only.',
  })
  pendingQueue!: DashboardPendingItemDto[];
}
