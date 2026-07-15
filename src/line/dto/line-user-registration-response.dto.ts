import { ApiProperty } from '@nestjs/swagger';

/**
 * The owner-facing registration view returned by `POST /line-users/register`,
 * `PATCH /line-users/registration`, and `GET /line-users/status`. It carries the identity/contact
 * fields **plus** both the option **ids** (so the Pending edit form can pre-select the current
 * option) and the resolved option **names** (for display). The owner may see their own phone.
 */
export class LineUserRegistrationResponseDto {
  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  id!: string;

  @ApiProperty({ example: 'Somchai' })
  firstName!: string;

  @ApiProperty({ example: 'Jaidee' })
  lastName!: string;

  @ApiProperty({ example: '6412345678' })
  staffId!: string;

  @ApiProperty({ example: '081-234-5678' })
  phone!: string;

  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  departmentId!: string;

  @ApiProperty({
    example: 'Computer Science',
    description: 'Resolved department name.',
  })
  department!: string;

  @ApiProperty({ example: 'clx9z8y7x6w5v4u3t2s1r0q9' })
  personnelRoleId!: string;

  @ApiProperty({
    example: 'Teacher',
    description: 'Resolved personnel-role name.',
  })
  personnelRole!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-07-14T10:00:00.000Z' })
  updatedAt!: string;
}
