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

  /**
   * When the registration was SUBMITTED. ISO-8601.
   *
   * ⚠️ NOT `LineUser.followedAt`, which is the day they added the Official Account as a friend.
   * The two differ by however long someone took to fill in the form, and the registration screen
   * shows this one under `วันที่ลงทะเบียน`. That a row with no registration shows a dash there,
   * rather than a date, is the visible proof they are different fields: everyone has a follow
   * date, and only registered people have this one.
   */
  @ApiProperty({
    example: '2026-08-06T09:15:00.000Z',
    description:
      'When the registration was submitted (NOT the LINE follow date).',
  })
  createdAt!: string;
}
