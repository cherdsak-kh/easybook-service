import { ApiProperty } from '@nestjs/swagger';
import {
  OccupancyDto,
  ReportRangeDto,
  RequestBreakdownDto,
} from './reports-overview-response.dto';

/** design §2.5 — `GET /api/v1/reports/venues` (Hub 2). */

/** One hour cell. Index `i = (isoWeekday − 1) × 8 + j`, `j` = 0…7 → 08:30, 09:30, …, 15:30 (Bangkok). */
export class ReportHeatCellDto {
  @ApiProperty({
    description:
      'Held hours inside this 1-hour cell summed over every school day of this weekday in range ' +
      '(unrounded). Σ over the 40 cells of `heatmap` = occupancy.heldHours.',
  })
  heldHours!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Number of held slot-day segments overlapping this cell ("มีการใช้งาน N รายการ").',
  })
  segments!: number;
}

export class ReportVenueClashDto {
  @ApiProperty({
    minimum: 1,
    maximum: 7,
    description:
      "ISO weekday of the auto-rejected request's first slot, Bangkok (1 = Monday … 7 = Sunday).",
  })
  isoWeekday!: number;

  @ApiProperty({
    example: '09:30',
    pattern: '^\\d{2}:\\d{2}$',
    description: 'First slot start, Bangkok HH:MM.',
  })
  startTime!: string;

  @ApiProperty({
    example: '11:30',
    pattern: '^\\d{2}:\\d{2}$',
    description: 'First slot end, Bangkok HH:MM.',
  })
  endTime!: string;

  @ApiProperty({
    minimum: 1,
    description: 'Auto-rejected requests sharing this (weekday, start, end).',
  })
  count!: number;
}

export class ReportVenueRowDto {
  @ApiProperty()
  venueId!: string;

  @ApiProperty({
    description:
      'History name (no deletedAt filter). Client appends "(ลบแล้ว)" / "(ปิดให้จอง)".',
  })
  name!: string;

  @ApiProperty({
    description:
      'VenueType.name, resolved as history (may be the tombstone ไม่พบประเภทสถานที่).',
  })
  typeName!: string;

  @ApiProperty({ minimum: 1, description: 'Venue.capacity ("จุ N คน").' })
  capacity!: number;

  @ApiProperty({ description: 'Current open state (closed → tier ปิดให้จอง).' })
  isOpen!: boolean;

  @ApiProperty({
    description:
      'Soft-deleted; present only when it has hours or requests in range (D-17).',
  })
  isDeleted!: boolean;

  @ApiProperty({
    description:
      "Held hours, same clipping as OccupancyDto, unrounded. Equals this venue's heldHours in /reports/overview venues[].",
  })
  heldHours!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '0–100 unrounded: heldHours ÷ (schoolDays × 8) × 100. null when schoolDays = 0.',
  })
  occupancyPercent!: number | null;

  @ApiProperty({
    minimum: 0,
    description:
      'Attributed requests whose BookingRequest.venueId is this venue, all statuses.',
  })
  requests!: number;

  @ApiProperty({ minimum: 0, description: 'Of requests: status = APPROVED.' })
  approved!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Of requests: rejectReason === AUTO_REJECTED_REASON (ADR-001).',
  })
  autoRejected!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '100 × autoRejected / requests, unrounded; null when requests = 0.',
  })
  autoRejectedPercent!: number | null;

  @ApiProperty({
    type: [ReportHeatCellDto],
    minItems: 40,
    maxItems: 40,
    description: "This venue's 40 cells (k = 1 on the client).",
  })
  cells!: ReportHeatCellDto[];

  @ApiProperty({
    type: ReportVenueClashDto,
    nullable: true,
    description:
      'Most frequent auto-reject (weekday, first-slot start, end); null when autoRejected = 0.',
  })
  topClash!: ReportVenueClashDto | null;
}

export class ReportsVenuesResponseDto {
  @ApiProperty({ format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: ReportRangeDto })
  range!: ReportRangeDto;

  @ApiProperty({
    type: RequestBreakdownDto,
    description: 'Identical to /reports/overview requests for the same range.',
  })
  requests!: RequestBreakdownDto;

  @ApiProperty({
    type: OccupancyDto,
    description:
      'Identical (===) to /reports/overview occupancy for the same range, unfiltered. venueCount is the open-venue count k.',
  })
  occupancy!: OccupancyDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '100 × requests.autoRejected / requests.total, unrounded; null when total = 0 (อัตราคำขอชนเวลา).',
  })
  clashPercent!: number | null;

  @ApiProperty({
    type: [Number],
    minItems: 5,
    maxItems: 5,
    description:
      'School days per weekday Mon…Fri within [startDate, effectiveEndDate]; Σ = range.schoolDays.',
  })
  weekdaySchoolDays!: number[];

  @ApiProperty({
    type: [ReportHeatCellDto],
    minItems: 40,
    maxItems: 40,
    description:
      'All-venue cells (scope "ทุกสถานที่"). Σ heldHours = occupancy.heldHours.',
  })
  heatmap!: ReportHeatCellDto[];

  @ApiProperty({
    type: [ReportVenueRowDto],
    description:
      'Every non-deleted venue + deleted venues with activity; sorted occupancy desc, requests desc, name. Unpaginated.',
  })
  venues!: ReportVenueRowDto[];
}
