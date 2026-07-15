import { ApiProperty } from '@nestjs/swagger';

/**
 * The compact registration summary embedded in each admin `GET /line-users` row, so an admin
 * approves a *person* rather than a bare LINE handle. `department` and `personnelRole` are the
 * **resolved option names** (human-readable labels), not ids — admins view, they do not edit the
 * registration. A row whose option was later soft-deleted still resolves its name (the FK row
 * persists). `phone` is included so admins can vet a registration by contacting the applicant.
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

  @ApiProperty({
    example: 'Computer Science',
    description: 'Resolved department name.',
  })
  department!: string;

  @ApiProperty({
    example: 'Teacher',
    description: 'Resolved personnel-role name.',
  })
  personnelRole!: string;
}
