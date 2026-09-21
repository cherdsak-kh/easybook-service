import { ApiProperty } from '@nestjs/swagger';
import { FeedbackStatus, FeedbackType } from '@prisma/client';
import { PaginationMetaDto } from '../../system-users/dto/paginated-system-users-response.dto';

/**
 * Response shapes of the admin triage console (ADMIN-FEEDBACK-1).
 *
 * ⚠️ SCHEMA NAMES ARE THE CLASS NAMES, and none reuses a LIFF name (`CreateFeedbackDto`,
 * `FeedbackResponseDto`, `FeedbackPhotoUploadResponseDto`). `FeedbackType` and `PaginationMetaDto` are
 * REFERENCED, never redeclared — a second declaration would mint `PaginationMetaDto1` in the
 * generated client.
 *
 * 🔴 PDPA: every one of these carries PII to a staff screen (name, phone, free text). That is the
 * product (all three roles read the whole record, plan §8). What none of them carries is the LINE
 * `U…` subject — `lineUser.lineUserId` is never selected (AC-13).
 */

export class AdminFeedbackVenueDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    example: 'ห้องประชุม 1',
    description:
      'Resolved as HISTORY: a venue soft-deleted after the report still shows its name (E-3).',
  })
  name!: string;
}

/**
 * ONE reporter shape for list and detail (design C-6), so the two cannot drift apart.
 *
 * Every field is nullable (D-8): a missing registration yields nulls, never a 500. The client
 * composes the display name — `firstName lastName`, else `lineDisplayName`, else its own fallback.
 */
export class AdminFeedbackReporterDto {
  @ApiProperty({ type: String, nullable: true, example: 'สมชาย' })
  firstName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ใจดี' })
  lastName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'ครู' })
  personnelRoleName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'กลุ่มบริหารงานวิชาการ',
  })
  departmentName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '081-234-5678' })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The LINE profile display name — the name shown when no registration exists.',
    example: 'Somchai',
  })
  lineDisplayName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The LINE profile picture URL, or null if unset — the reporter card falls back to initials.',
    example: 'https://profile.line-scdn.net/0hAbCdEf',
  })
  pictureUrl!: string | null;
}

export class AdminFeedbackListItemDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'ISS-25690920-001' })
  code!: string;

  @ApiProperty({ enum: FeedbackType, enumName: 'FeedbackType' })
  type!: FeedbackType;

  @ApiProperty({ enum: FeedbackStatus, enumName: 'FeedbackStatus' })
  status!: FeedbackStatus;

  @ApiProperty({ example: 'แอร์ห้องประชุม 1 ไม่เย็น' })
  subject!: string;

  @ApiProperty({
    example: 'แอร์ตัวที่อยู่ฝั่งหน้าต่างไม่ทำงานมา 3 วันแล้วครับ',
  })
  description!: string;

  @ApiProperty({
    example: 2,
    minimum: 0,
    maximum: 3,
    description:
      'How many photos are attached. The list does not ship the URLs.',
  })
  photoCount!: number;

  @ApiProperty({
    type: AdminFeedbackVenueDto,
    nullable: true,
    description: 'null = ปัญหาทั่วไป / ไม่ระบุสถานที่',
  })
  venue!: AdminFeedbackVenueDto | null;

  @ApiProperty({ type: AdminFeedbackReporterDto })
  reporter!: AdminFeedbackReporterDto;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-20T13:05:00.000Z',
  })
  createdAt!: string;
}

/** Resolved as HISTORY (no `deletedAt` filter). `null` only after a staff HARD delete (OQ-3). */
export class FeedbackLogAuthorDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'วีระ' })
  firstName!: string;

  @ApiProperty({ example: 'ทองดี' })
  lastName!: string;
}

export class FeedbackLogDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    enum: FeedbackStatus,
    enumName: 'FeedbackStatus',
    description:
      'The status the report was LEFT in by this save — equal to the prior status on a note-only save.',
  })
  status!: FeedbackStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Internal staff note — never sent to the reporter. null = a status-only change.',
  })
  note!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-21T08:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    type: FeedbackLogAuthorDto,
    nullable: true,
    description:
      'The staff member who saved it. null only when their account was hard-deleted.',
  })
  author!: FeedbackLogAuthorDto | null;
}

export class AdminFeedbackDetailDto extends AdminFeedbackListItemDto {
  @ApiProperty({
    type: [String],
    description:
      'Public URLs in stored (attachment) order (D-7). Rendered directly; the backend never fetches them.',
    example: [
      'https://cdn.example.org/feedback/0123456789abcdef0123456789abcdef.jpg',
    ],
  })
  photos!: string[];

  @ApiProperty({
    type: [FeedbackLogDto],
    description:
      '`createdAt` ASC; `[]` for a report nobody has touched (there is no synthesised "submitted" entry). The UI reverses it for display (D-11).',
  })
  logs!: FeedbackLogDto[];
}

export class FeedbackCountsDto {
  @ApiProperty({
    example: 5,
    description: '`status = PENDING` over the WHOLE table.',
  })
  pendingCount!: number;

  @ApiProperty({
    example: 12,
    description: '`type = ISSUE` over the WHOLE table.',
  })
  issueCount!: number;

  @ApiProperty({
    example: 8,
    description: '`type = FEEDBACK` over the WHOLE table.',
  })
  feedbackCount!: number;
}

export class PaginatedFeedbackResponseDto {
  @ApiProperty({ type: [AdminFeedbackListItemDto] })
  data!: AdminFeedbackListItemDto[];

  @ApiProperty({
    type: PaginationMetaDto,
    description: '`total` is the count AFTER filters — what the pager needs.',
  })
  meta!: PaginationMetaDto;

  /**
   * 🔴 GLOBAL — computed with NO `where` at all (AC-8). The tab pills, the `<h1>` chip and the
   * sidebar count describe the whole table in the prototype (`paintCounts`), so a filter must never
   * move them.
   */
  @ApiProperty({
    type: FeedbackCountsDto,
    description:
      'GLOBAL: unaffected by `type` / `status` / `venueId` / `q` / `page` (AC-8). ทั้งหมด = issueCount + feedbackCount.',
  })
  counts!: FeedbackCountsDto;
}
