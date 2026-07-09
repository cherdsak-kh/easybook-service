import { ApiProperty } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';

/**
 * The one canonical public view of a `SystemUser`. Exactly the `PUBLIC_FIELDS` select.
 *
 * Neither the password digest nor `deletedAt` appears here, in any other DTO, in any `select`
 * that reaches a response, or in any log line (AC-5, AC-32).
 */
export class SystemUserResponseDto {
  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  id!: string;

  @ApiProperty({ example: 'admin@easybook.local' })
  email!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  name!: string;

  @ApiProperty({ enum: SystemRole, example: SystemRole.STAFF })
  role!: SystemRole;

  @ApiProperty({ example: 'Teacher', maxLength: 100 })
  position!: string;

  @ApiProperty({ example: 'Computer Science', maxLength: 120 })
  department!: string;

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
}
