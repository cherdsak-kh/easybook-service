import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';
import { SystemUserCreatorDto } from './system-user-creator.dto';
import { SystemUserOptionDto } from './system-user-option.dto';

/**
 * The one canonical public view of a `SystemUser`. Exactly the `PUBLIC_FIELDS` select.
 *
 * Neither the password digest nor `deletedAt` appears here, in any other DTO, in any `select`
 * that reaches a response, or in any log line (AC-5, AC-32).
 */
// `@ApiExtraModels` pins `SystemUserCreatorDto` into the schema graph explicitly: a class reached
// only through a NULLABLE property can otherwise drop out of `/docs-json`, and the frontend
// generates `api-types.ts` from that document.
@ApiExtraModels(SystemUserCreatorDto)
export class SystemUserResponseDto {
  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  id!: string;

  @ApiProperty({ example: 'admin@easybook.local' })
  email!: string;

  @ApiProperty({ example: 'Ada' })
  firstName!: string;

  @ApiProperty({ example: 'Lovelace' })
  lastName!: string;

  @ApiProperty({
    enum: SystemRole,
    example: SystemRole.STAFF,
    description:
      'Back-office RBAC. The ONLY field that grants privilege — never `personnelRole`.',
  })
  role!: SystemRole;

  @ApiProperty({ type: SystemUserOptionDto })
  department!: SystemUserOptionDto;

  @ApiProperty({
    type: SystemUserOptionDto,
    description: 'Job title. NOT `role` — grants zero privilege.',
  })
  personnelRole!: SystemUserOptionDto;

  @ApiProperty({
    example: false,
    description:
      'True while a temp password is outstanding; every route except logout / GET me / POST password answers 403.',
  })
  mustChangePassword!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '02-123-4567 ext. 101',
  })
  phoneNumber!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://cdn.example.com/a.jpg',
  })
  profilePictureUrl!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    readOnly: true,
    example: 'clx9z8y7x6w5v4u3t2s1r0q9',
    description:
      'Linked LineUser.id (a cuid), or null. NOT the LINE "U…" identifier. Read-only; set by a future endpoint.',
  })
  lineUserId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-07-08T11:00:00.000Z',
  })
  lastLoginAt!: string | null;

  @ApiProperty({ example: '2026-07-08T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    type: SystemUserCreatorDto,
    nullable: true,
    readOnly: true,
    description:
      'Who created this account (audit provenance). Resolved WITHOUT a `deletedAt` filter, so a soft-deleted creator still resolves, forever. Null only for the seeded first SUPER_ADMIN. Carries no email and no role, deliberately.',
  })
  createdBy!: SystemUserCreatorDto | null;

  // `format: date-time` is spelled out here per the design's contract delta. `createdAt` and
  // `lastLoginAt` deliberately keep their existing annotations: this change is additive only, and
  // editing an already-published property is out of its scope.
  @ApiProperty({
    type: String,
    format: 'date-time',
    readOnly: true,
    example: '2026-07-26T20:42:00.000Z',
    description: 'Last write to this row, in ISO 8601. Never null.',
  })
  updatedAt!: string;
}
