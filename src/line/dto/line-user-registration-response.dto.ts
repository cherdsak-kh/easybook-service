import { ApiProperty } from '@nestjs/swagger';

/**
 * The owner-facing registration view returned by `POST /line-users/register` and
 * `GET /line-users/status`. It carries the summary fields **plus** `id`, `phone`, and timestamps —
 * the owner may see their own phone; the admin list summary omits it.
 */
export class LineUserRegistrationResponseDto {
  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  id!: string;

  @ApiProperty({ example: 'Somchai' })
  firstName!: string;

  @ApiProperty({ example: 'Jaidee' })
  lastName!: string;

  @ApiProperty({ example: '6412345678' })
  studentStaffId!: string;

  @ApiProperty({ example: '081-234-5678' })
  phone!: string;

  @ApiProperty({ example: 'Computer Science' })
  department!: string;

  @ApiProperty({ example: 'Student' })
  role!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  updatedAt!: string;
}
