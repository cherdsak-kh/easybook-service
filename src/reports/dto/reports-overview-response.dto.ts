import { ApiProperty } from '@nestjs/swagger';

/** design §2.5 — `GET /api/v1/reports/overview`. */

export enum TrendGrain {
  MONTH = 'MONTH',
  WEEK = 'WEEK',
}

export class ReportRangeDto {
  @ApiProperty({ format: 'date' })
  startDate!: string;

  @ApiProperty({ format: 'date' })
  endDate!: string;

  @ApiProperty({
    format: 'date',
    description: 'Bangkok yesterday at serverTime. Data stops here (D-10).',
  })
  dataUntilDate!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'min(endDate, dataUntilDate); null when startDate > dataUntilDate (empty result).',
  })
  effectiveEndDate!: string | null;

  @ApiProperty({
    minimum: 1,
    maximum: 366,
    description: 'Inclusive span of the SELECTED range ("(N วัน)").',
  })
  days!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Mon–Fri excluding 1 Apr–15 May, within [startDate, effectiveEndDate]. "วันทำการ N วัน".',
  })
  schoolDays!: number;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'Bangkok date of min(firstStartAt) over ALL requests, unfiltered; null on an empty table. The client uses it for "ไม่มีข้อมูลช่วงก่อนหน้าให้เทียบ".',
  })
  dataStartDate!: string | null;
}

/**
 * ⚠️ PO RULING OQ-2 (this task's brief, overriding the design where it is silent): every one of the
 * five mutually-exclusive statuses gets BOTH a count and a `*Percent` field, so
 * `approvedPercent + rejectedPercent + cancelledPercent + expiredPercent + pendingPercent` sums to
 * exactly 100 (of `total`, unrounded) — closing the exact gap the plan's D-10/OQ-2 flagged ("the
 * three badges may sum to less than 100%" because EXPIRED had no badge). `autoRejected` stays a
 * count only: it is a SUBSET of `rejected`, not a sixth partition, and giving it a percent would
 * double-count against `rejectedPercent`.
 */
export class RequestBreakdownDto {
  @ApiProperty({
    description:
      'All five statuses (OQ-2: total = approved + rejected + cancelled + expired + pending).',
  })
  total!: number;

  @ApiProperty()
  approved!: number;

  @ApiProperty({
    type: Number,
    description: '100 × approved / total, unrounded; 0 when total = 0 (OQ-2).',
  })
  approvedPercent!: number;

  @ApiProperty({ description: 'Includes autoRejected.' })
  rejected!: number;

  @ApiProperty({
    type: Number,
    description: '100 × rejected / total, unrounded; 0 when total = 0 (OQ-2).',
  })
  rejectedPercent!: number;

  @ApiProperty({
    description:
      'Subset of rejected: rejectReason === AUTO_REJECTED_REASON (R-2). No percent field — it is a SUBSET of rejected, not a sixth partition.',
  })
  autoRejected!: number;

  @ApiProperty()
  cancelled!: number;

  @ApiProperty({
    type: Number,
    description: '100 × cancelled / total, unrounded; 0 when total = 0 (OQ-2).',
  })
  cancelledPercent!: number;

  @ApiProperty({
    description:
      'OQ-2: broken out so approved/rejected/cancelled/expired (+pending) sum to total.',
  })
  expired!: number;

  @ApiProperty({
    type: Number,
    description:
      '100 × expired / total, unrounded; 0 when total = 0 (OQ-2 — the field the PO ruling names explicitly).',
  })
  expiredPercent!: number;

  @ApiProperty({
    description:
      'Still PENDING among attributed rows (normally 0 for past dates).',
  })
  pending!: number;

  @ApiProperty({
    type: Number,
    description: '100 × pending / total, unrounded; 0 when total = 0 (OQ-2).',
  })
  pendingPercent!: number;
}

export class OccupancyDto {
  @ApiProperty({
    description:
      'Held hours inside 08:30–16:30 on school days, unrounded (D-10).',
  })
  heldHours!: number;

  @ApiProperty()
  schoolDays!: number;

  @ApiProperty({
    description:
      'Current open, non-deleted venues; 1 when venueId is set. "× M สถานที่".',
  })
  venueCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '0–100, UNROUNDED (the client shows 1 dp and computes the Δ from unrounded values). null when schoolDays × venueCount = 0.',
  })
  occupancyPercent!: number | null;
}

export class DisciplineDto {
  @ApiProperty()
  lateCancellations!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'ALWAYS null in Phase 1: no attendance data exists (D-9). Never 0.',
  })
  noShows!: number | null;

  @ApiProperty({
    description:
      'Attributed requests with approvedAt ≠ null (the rate denominator).',
  })
  grantedRequests!: number;

  @ApiProperty({ description: '0–100, unrounded; 0 when grantedRequests = 0.' })
  lateCancellationPercent!: number;

  @ApiProperty({
    description: 'Current booking.cancel_lead_minutes used for "late" (E-24).',
  })
  cancelLeadMinutes!: number;
}

export class TrendBucketDto {
  @ApiProperty({ format: 'date' })
  from!: string;

  @ApiProperty({ format: 'date' })
  to!: string;

  @ApiProperty({
    description:
      'The calendar month/ISO week was clipped by the range → "(บางส่วน)".',
  })
  partial!: boolean;

  @ApiProperty({
    description: 'from > dataUntilDate → greyed, "ยังไม่ถึงช่วงเวลานี้".',
  })
  future!: boolean;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  approved!: number;

  @ApiProperty()
  rejected!: number;

  @ApiProperty()
  autoRejected!: number;

  @ApiProperty()
  cancelled!: number;

  @ApiProperty()
  expired!: number;

  @ApiProperty()
  pending!: number;

  @ApiProperty()
  heldHours!: number;

  @ApiProperty({ description: 'Counted up to effectiveEndDate.' })
  schoolDays!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '0–100 unrounded; null when future or 0 school days.',
  })
  occupancyPercent!: number | null;
}

export class TrendDto {
  @ApiProperty({
    enum: TrendGrain,
    enumName: 'TrendGrain',
    description:
      'MONTH iff (endDate − startDate) in days > 45, else WEEK (prototype autoGrain).',
  })
  defaultGrain!: TrendGrain;

  @ApiProperty({
    type: [TrendBucketDto],
    description: 'Calendar months, clipped, oldest first (≤ 13).',
  })
  month!: TrendBucketDto[];

  @ApiProperty({
    type: [TrendBucketDto],
    description: 'Mon–Sun weeks, clipped, oldest first (≤ 54).',
  })
  week!: TrendBucketDto[];
}

export class VenueUsageDto {
  @ApiProperty({ minimum: 1 })
  rank!: number;

  @ApiProperty()
  venueId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'Soft-deleted → client appends "(ลบแล้ว)".' })
  isDeleted!: boolean;

  @ApiProperty()
  isOpen!: boolean;

  @ApiProperty({ description: 'Held hours (same clipping as OccupancyDto).' })
  heldHours!: number;

  @ApiProperty({
    description:
      'heldHours ÷ (schoolDays × 8) × 100, unrounded; 0 when schoolDays = 0. Bar value.',
  })
  sharePercent!: number;
}

export class ReportsOverviewResponseDto {
  @ApiProperty({ format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: ReportRangeDto })
  range!: ReportRangeDto;

  @ApiProperty({ type: RequestBreakdownDto })
  requests!: RequestBreakdownDto;

  @ApiProperty({ type: OccupancyDto })
  occupancy!: OccupancyDto;

  @ApiProperty({ type: DisciplineDto })
  discipline!: DisciplineDto;

  @ApiProperty({
    description: 'count(status=PENDING) NOW, ignoring every filter (AC-R8).',
  })
  pendingBacklog!: number;

  @ApiProperty({ type: TrendDto })
  trend!: TrendDto;

  @ApiProperty({
    type: [VenueUsageDto],
    description:
      'EVERY venue with heldHours > 0, ranked by heldHours desc then name. The client shows the first 5; Σ heldHours = occupancy.heldHours when unfiltered (AC-R11).',
  })
  venues!: VenueUsageDto[];
}
