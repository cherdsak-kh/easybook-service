import { ApiProperty } from '@nestjs/swagger';
import {
  DisciplineDto,
  ReportRangeDto,
  RequestBreakdownDto,
} from './reports-overview-response.dto';

/** design §2.6 — `GET /api/v1/reports/operations` (Hub 3). */

export enum ReportPurposeCategory {
  TEACHING = 'TEACHING',
  MEETING = 'MEETING',
  TRAINING = 'TRAINING',
  STUDENT_ACTIVITY = 'STUDENT_ACTIVITY',
  OTHER = 'OTHER',
}

export enum ReportSlaBucket {
  UNDER_2H = 'UNDER_2H',
  FROM_2H_TO_12H = 'FROM_2H_TO_12H',
  FROM_12H_TO_24H = 'FROM_12H_TO_24H',
  OVER_24H = 'OVER_24H',
}

export enum ReportCancellerKind {
  REQUESTER = 'REQUESTER',
  STAFF = 'STAFF',
  UNKNOWN = 'UNKNOWN',
}

export class ReportDepartmentRowDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Department.id; null = the ไม่ระบุกลุ่ม/ฝ่าย bucket (no resolvable department, or — for ADMIN/VIEWER — a system-reserved one, D-20).',
  })
  departmentId!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'History name; null for the unassigned bucket.',
  })
  name!: string | null;

  @ApiProperty({
    description:
      'Soft-deleted; such rows appear only with activity. Client appends "(ลบแล้ว)".',
  })
  isDeleted!: boolean;

  @ApiProperty({ minimum: 0 })
  requests!: number;

  @ApiProperty({ minimum: 0, description: 'status = APPROVED.' })
  approved!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '100 × approved / requests, unrounded; null when requests = 0.',
  })
  approvalPercent!: number | null;

  @ApiProperty({
    description:
      'Held hours of slots whose parent resolves to this bucket, unrounded.',
  })
  heldHours!: number;

  @ApiProperty({
    description:
      '100 × heldHours / total heldHours, unrounded; 0 when total = 0. Share of USE, not capacity (D-21).',
  })
  sharePercent!: number;

  @ApiProperty({
    minimum: 0,
    description: 'D-11 late cancellations attributed to this bucket.',
  })
  lateCancellations!: number;
}

export class ReportPurposeRowDto {
  @ApiProperty({
    enum: ReportPurposeCategory,
    enumName: 'ReportPurposeCategory',
  })
  category!: ReportPurposeCategory;

  @ApiProperty({ minimum: 0 })
  requests!: number;

  @ApiProperty()
  heldHours!: number;

  @ApiProperty({
    description:
      '100 × heldHours / total heldHours, unrounded; 0 when total = 0.',
  })
  sharePercent!: number;
}

export class ReportSlaBucketRowDto {
  @ApiProperty({ enum: ReportSlaBucket, enumName: 'ReportSlaBucket' })
  bucket!: ReportSlaBucket;

  @ApiProperty({ minimum: 0 })
  count!: number;

  @ApiProperty({
    description: '100 × count / decided, unrounded; 0 when decided = 0.',
  })
  percent!: number;
}

export class ReportSlaExclusionsDto {
  @ApiProperty({
    description: 'ADR-001 auto-rejections (= requests.autoRejected).',
  })
  autoRejected!: number;

  @ApiProperty({
    description:
      'CANCELLED with approvedAt = null (withdrawn before any decision).',
  })
  withdrawn!: number;

  @ApiProperty({
    description: 'createdById ≠ null (direct and on-behalf staff bookings).',
  })
  staffCreated!: number;

  @ApiProperty({
    description: 'EXPIRED before any decision (หมดอายุก่อนพิจารณา).',
  })
  expired!: number;

  @ApiProperty({ description: 'Still PENDING.' })
  pending!: number;
}

export class ReportSlaDto {
  @ApiProperty({ example: 24 })
  slaHours!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'n: LIFF requests a person ruled on. n + Σ excluded = requests.total.',
  })
  decided!: number;

  @ApiProperty({ minimum: 0 })
  decidedApproved!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Manual rejections; turnaround is the updatedAt proxy (approximate).',
  })
  decidedRejected!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mean turnaround, wall-clock hours, unrounded; null when decided = 0.',
  })
  averageHours!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Lower median, hours; null when decided = 0.',
  })
  medianHours!: number | null;

  @ApiProperty({
    minimum: 0,
    description: 'Turnaround ≤ 24 h 0 m (exactly 24 h is within).',
  })
  withinSla!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '100 × withinSla / decided, unrounded; null when decided = 0.',
  })
  withinSlaPercent!: number | null;

  @ApiProperty({
    type: [ReportSlaBucketRowDto],
    minItems: 4,
    maxItems: 4,
    description:
      'Fixed order UNDER_2H, FROM_2H_TO_12H, FROM_12H_TO_24H (12 ≤ t ≤ 24), OVER_24H; Σ count = decided.',
  })
  buckets!: ReportSlaBucketRowDto[];

  @ApiProperty({ type: ReportSlaExclusionsDto })
  excluded!: ReportSlaExclusionsDto;
}

/** ⛔ PDPA (D-26): no requester name, phone, LINE id or registration field — for any role. */
export class ReportLateCancellationDto {
  @ApiProperty({ example: 'BR-25690902-001' })
  code!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Start of the EARLIEST late-cancelled slot.',
  })
  slotStartAt!: Date;

  @ApiProperty({ format: 'date-time' })
  slotEndAt!: Date;

  @ApiProperty({
    minimum: 1,
    description:
      'Late-cancelled slots of this request; the client shows "(+N ช่วง)" for N = lateSlotCount − 1 > 0.',
  })
  lateSlotCount!: number;

  @ApiProperty({ description: 'cancelledAt ≥ startAt ("หลังเริ่ม N นาที").' })
  cancelledAfterStart!: boolean;

  @ApiProperty({
    minimum: 0,
    description: '⌊|startAt − cancelledAt| / 1 min⌋.',
  })
  minutes!: number;

  @ApiProperty()
  venueName!: string;

  @ApiProperty()
  venueIsDeleted!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Effective department after D-20 folding; null → ไม่ระบุกลุ่ม/ฝ่าย.',
  })
  departmentName!: string | null;

  @ApiProperty()
  departmentIsDeleted!: boolean;

  @ApiProperty({
    enum: ReportCancellerKind,
    enumName: 'ReportCancellerKind',
    description:
      'LINE_USER → REQUESTER; SUPER_ADMIN/ADMIN → STAFF; else UNKNOWN. Shown, never counted differently (OQ-4).',
  })
  canceller!: ReportCancellerKind;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Free text; may name a person — already visible to all three roles on the request detail (no new exposure).',
  })
  cancelReason!: string | null;
}

export class ReportsOperationsResponseDto {
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
    description:
      'Total held hours in range (= /reports/overview occupancy.heldHours).',
  })
  heldHours!: number;

  @ApiProperty({
    type: DisciplineDto,
    description:
      'Identical to /reports/overview discipline (noShows always null).',
  })
  discipline!: DisciplineDto;

  @ApiProperty({
    type: [ReportDepartmentRowDto],
    description:
      'D-20 row set; sorted hours desc, requests desc, name; the null row last.',
  })
  departments!: ReportDepartmentRowDto[];

  @ApiProperty({
    type: [ReportPurposeRowDto],
    minItems: 5,
    maxItems: 5,
    description: 'Four categories by hours desc, OTHER always last (D-22).',
  })
  purposes!: ReportPurposeRowDto[];

  @ApiProperty({ type: ReportSlaDto })
  sla!: ReportSlaDto;

  @ApiProperty({
    type: [ReportLateCancellationDto],
    description:
      'One row per late-cancelled request; length = discipline.lateCancellations. Unpaginated.',
  })
  registry!: ReportLateCancellationDto[];
}
