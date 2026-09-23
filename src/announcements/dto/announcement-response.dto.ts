import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import {
  AnnouncementAudience,
  AnnouncementFormat,
  AnnouncementStatus,
} from '@prisma/client';
import { PaginationMetaDto } from '../../system-users/dto/paginated-system-users-response.dto';

/**
 * Response shapes of the admin announcements surface (ANNOUNCE-API-1).
 *
 * ⚠️ SCHEMA NAMES ARE THE CLASS NAMES, so none reuses another module's (`FeedbackLogAuthorDto` has
 * the creator's shape but is not reused — a second registration under one name overwrites the first).
 * `PaginationMetaDto` is REFERENCED, never redeclared: a redeclaration would mint `PaginationMetaDto1`
 * in the generated client.
 *
 * ONE item shape for list AND detail (design S-4): `body` is capped at 1000 characters, so there is
 * nothing to trim from the list, and one shape cannot drift. Raw `departmentId` / `createdById` are
 * NOT exposed — `department.id` / `createdBy.id` carry them.
 */

/** Resolved as HISTORY (no `deletedAt` filter): a department soft-deleted after drafting still shows. */
export class AnnouncementDepartmentDto {
  @ApiProperty({ example: 3, description: 'Auto-increment integer id.' })
  id!: number;

  @ApiProperty({ example: 'กลุ่มบริหารงานวิชาการ' })
  name!: string;
}

/**
 * The staff member who drafted it — ONLY `id`, `firstName`, `lastName`; never email, role or avatar.
 * Resolved as HISTORY: a soft-deleted staff member still resolves.
 */
export class AnnouncementCreatorDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'วีระ' })
  firstName!: string;

  @ApiProperty({ example: 'ทองดี' })
  lastName!: string;
}

// `@ApiExtraModels` pins both nested classes into the schema graph: a class reached only through a
// NULLABLE property can otherwise drop out of `/docs-json` (the `SystemUserResponseDto` precedent).
@ApiExtraModels(AnnouncementDepartmentDto, AnnouncementCreatorDto)
export class AnnouncementDto {
  @ApiProperty({ example: 'clx0v3n0e0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: 'ปิดปรับปรุงห้องประชุม 1 วันที่ 25 ก.ย.' })
  title!: string;

  @ApiProperty({
    description: '`""` for a title-only draft.',
    example: 'ขออภัยในความไม่สะดวก',
  })
  body!: string;

  @ApiProperty({ enum: AnnouncementFormat, enumName: 'AnnouncementFormat' })
  format!: AnnouncementFormat;

  @ApiProperty({
    enum: AnnouncementStatus,
    enumName: 'AnnouncementStatus',
    description:
      'A row is created as `DRAFT`; only `POST /announcements/{id}/send` makes it `SENT`. `SENT` rows cannot be edited (PATCH → 409) or sent again; DRAFT and SENT rows alike can be soft-deleted (DELETE → 204).',
  })
  status!: AnnouncementStatus;

  @ApiProperty({ enum: AnnouncementAudience, enumName: 'AnnouncementAudience' })
  audience!: AnnouncementAudience;

  @ApiProperty({
    type: AnnouncementDepartmentDto,
    nullable: true,
    description:
      'null iff `audience` is `ALL` — or after a HARD delete of the department (never happens through the API; departments are soft-deleted).',
  })
  department!: AnnouncementDepartmentDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the send committed; null for a DRAFT.',
  })
  sentAt!: string | null;

  @ApiProperty({
    example: 0,
    minimum: 0,
    description:
      'Recipients whose multicast request LINE **accepted** (HTTP 200, or 409 on a repeated retry key). Not a delivered or read count: LINE silently drops users who blocked the OA. On a partial send (502 `ANNOUNCEMENT_PARTIALLY_SENT`) it is less than the targeted count. 0 for a DRAFT, and for a SENT row whose send found nobody eligible (no LINE call was made).',
  })
  sentCount!: number;

  @ApiProperty({
    type: AnnouncementCreatorDto,
    nullable: true,
    description: 'null only after the staff account was HARD-deleted.',
  })
  createdBy!: AnnouncementCreatorDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T08:00:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-09-22T08:05:00.000Z',
  })
  updatedAt!: string;
}

export class PaginatedAnnouncementsResponseDto {
  @ApiProperty({ type: [AnnouncementDto] })
  data!: AnnouncementDto[];

  @ApiProperty({
    type: PaginationMetaDto,
    description: '`total` is the count AFTER filters — what the pager needs.',
  })
  meta!: PaginationMetaDto;
}
