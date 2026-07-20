import { ApiProperty } from '@nestjs/swagger';

/**
 * The compact registration summary embedded in each admin `GET /line-users` row, so an admin
 * approves a *person* rather than a bare LINE handle. `department` and `personnelRole` are the
 * **resolved option names** (human-readable labels); `departmentId` / `personnelRoleId` are the raw
 * FK ids. A row whose option was later soft-deleted still resolves its name (the FK row persists).
 * `phone` is included so admins can vet a registration by contacting the applicant.
 *
 * The two ids are surfaced so the admin edit modal can pre-select its `<select>`s without a second
 * fetch. Purely additive — it enriches the `GET /line-users` list and the `PATCH /line-users/:id`
 * access-edit response uniformly (all serialize this DTO).
 */
export class LineUserRegistrationSummaryDto {
  @ApiProperty({ example: 'Somchai' })
  firstName!: string;

  @ApiProperty({ example: 'Jaidee' })
  lastName!: string;

  @ApiProperty({ example: '6412345678' })
  staffId!: string;

  @ApiProperty({ example: '081-234-5678' })
  phone!: string;

  @ApiProperty({ example: 1, description: 'Department option FK id.' })
  departmentId!: number;

  @ApiProperty({
    example: 'Computer Science',
    description: 'Resolved department name.',
  })
  department!: string;

  @ApiProperty({ example: 1, description: 'Personnel-role option FK id.' })
  personnelRoleId!: number;

  @ApiProperty({
    example: 'Teacher',
    description: 'Resolved personnel-role name.',
  })
  personnelRole!: string;
}
