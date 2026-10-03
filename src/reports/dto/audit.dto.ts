import { ApiProperty } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';

/** The prototype's action vocabulary, in its own order (TYPE_ORDER). */
export enum AuditAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  CANCEL = 'CANCEL',
  DIRECT_BOOKING = 'DIRECT_BOOKING',
  VENUE_UPDATE = 'VENUE_UPDATE',
  ACCOUNT = 'ACCOUNT',
  BROADCAST = 'BROADCAST',
}

export enum AuditTargetKind {
  BOOKING_REQUEST = 'BOOKING_REQUEST',
  VENUE = 'VENUE',
  LINE_USER = 'LINE_USER',
  STAFF_ACCOUNT = 'STAFF_ACCOUNT',
  ANNOUNCEMENT = 'ANNOUNCEMENT',
}

export enum AuditActorState {
  ACTIVE = 'ACTIVE',
  SOFT_DELETED = 'SOFT_DELETED',
  HARD_DELETED = 'HARD_DELETED',
}

/** `SYNTHESIZED` = reconstructed from existing columns (PO ruling OQ-P3-1); `RECORDED` = a future audit table. */
export enum AuditSource {
  SYNTHESIZED = 'SYNTHESIZED',
  RECORDED = 'RECORDED',
}

export class AuditActorDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when the actor row was hard-deleted and its FK nulled.',
  })
  id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty({
    enum: SystemRole,
    nullable: true,
    description:
      "The actor's CURRENT role, except for CANCEL events, which carry the role AT THE TIME (`cancelledByRole`).",
  })
  role!: SystemRole | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Job title (PersonnelRole.name). Null for a system-reserved title when the caller is not SUPER_ADMIN.',
  })
  position!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Null = ไม่ระบุกลุ่ม/ฝ่าย (also what a system-reserved department folds to for a non-SUPER_ADMIN, P2 D-20).',
  })
  department!: string | null;

  @ApiProperty({ enum: AuditActorState, enumName: 'AuditActorState' })
  state!: AuditActorState;
}

export class AuditTargetDto {
  @ApiProperty({ enum: AuditTargetKind, enumName: 'AuditTargetKind' })
  kind!: AuditTargetKind;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The target row id (booking request cuid, staff cuid, announcement cuid).',
  })
  id!: string | null;

  @ApiProperty({
    description: 'Booking code, staff full name or announcement title.',
  })
  label!: string;

  @ApiProperty({ type: String, nullable: true })
  detail!: string | null;

  @ApiProperty({
    description: 'Soft-deleted staff account / announcement / venue.',
  })
  isDeleted!: boolean;
}

export class AuditChangeDto {
  @ApiProperty()
  field!: string;

  @ApiProperty()
  before!: string;

  @ApiProperty()
  after!: string;
}

export class AuditEventDto {
  @ApiProperty({
    example: 'APV-BR-25690928-001',
    description:
      'Deterministic from the source row and never renumbered: APV-/DIR-/REJ-<code>, CAN-<code>-<instant base36>, ACC-<staff id>, ANN-<announcement id>.',
  })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'ISO 8601 with milliseconds.',
  })
  at!: string;

  @ApiProperty({
    description:
      'True for REJECT: the reject writes no timestamp of its own, so `updatedAt` stands in (P2 D-23).',
  })
  atIsApproximate!: boolean;

  @ApiProperty({ enum: AuditAction, enumName: 'AuditAction' })
  action!: AuditAction;

  @ApiProperty({
    type: AuditActorDto,
    nullable: true,
    description: 'Null = the source records no actor (REJECT, BROADCAST).',
  })
  actor!: AuditActorDto | null;

  @ApiProperty({ type: AuditTargetDto })
  target!: AuditTargetDto;

  @ApiProperty()
  summary!: string;

  @ApiProperty({
    type: [AuditChangeDto],
    nullable: true,
    description: 'Null = the source has no before/after (ACCOUNT).',
  })
  changes!: AuditChangeDto[] | null;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Always null while the source is SYNTHESIZED.',
  })
  ip!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Always null while the source is SYNTHESIZED.',
  })
  userAgent!: string | null;
}

export class AuditCapabilitiesDto {
  @ApiProperty({ enum: AuditSource, enumName: 'AuditSource' })
  source!: AuditSource;

  @ApiProperty({
    enum: AuditAction,
    enumName: 'AuditAction',
    isArray: true,
    description:
      'The action types this source can produce, in prototype order.',
  })
  actions!: AuditAction[];

  @ApiProperty({
    description:
      'False: hide the IP column, IP search and the IP/UA dialog rows.',
  })
  recordsIp!: boolean;

  @ApiProperty({ description: 'False: KPI 3 (การปรับปรุงทรัพยากร) shows —.' })
  recordsResourceChanges!: boolean;
}

export class AuditRangeDto {
  @ApiProperty({ format: 'date' })
  startDate!: string;

  @ApiProperty({ format: 'date' })
  endDate!: string;

  @ApiProperty({ minimum: 1, maximum: 366 })
  days!: number;
}

export class AuditPageDto {
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: AuditRangeDto })
  range!: AuditRangeDto;

  @ApiProperty({ type: AuditCapabilitiesDto })
  capabilities!: AuditCapabilitiesDto;

  @ApiProperty({ type: [AuditEventDto] })
  items!: AuditEventDto[];

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ enum: [10, 20, 50] })
  limit!: number;

  @ApiProperty({ description: 'Filtered count.' })
  total!: number;

  @ApiProperty({ minimum: 1 })
  totalPages!: number;
}

export class AuditTopActorDto {
  @ApiProperty({ type: AuditActorDto })
  actor!: AuditActorDto;

  @ApiProperty()
  count!: number;

  @ApiProperty({ description: '100 x count / total events in the range.' })
  percent!: number;
}

export class AuditKpisDto {
  @ApiProperty()
  total!: number;

  @ApiProperty({ minimum: 1, description: 'Inclusive days of the range.' })
  days!: number;

  @ApiProperty()
  approve!: number;

  @ApiProperty()
  reject!: number;

  @ApiProperty()
  cancel!: number;

  @ApiProperty()
  directBooking!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Null while the source records no venue changes (rendered —).',
  })
  resourceChanges!: number | null;

  @ApiProperty({
    type: AuditTopActorDto,
    nullable: true,
    description:
      'Only named actors qualify; ties go to the earlier name in Thai collation.',
  })
  topActor!: AuditTopActorDto | null;
}

export class AuditKpisResponseDto {
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: AuditRangeDto })
  range!: AuditRangeDto;

  @ApiProperty({
    type: AuditKpisDto,
    description: 'RANGE ONLY: the toolbar never changes it.',
  })
  kpis!: AuditKpisDto;
}

export class AuditActorOptionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  isDeleted!: boolean;
}

export class AuditActorsResponseDto {
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime!: Date;

  @ApiProperty({ type: AuditRangeDto })
  range!: AuditRangeDto;

  @ApiProperty({
    type: [AuditActorOptionDto],
    description:
      'Staff with at least one named event in the range, Thai-sorted.',
  })
  actors!: AuditActorOptionDto[];
}
