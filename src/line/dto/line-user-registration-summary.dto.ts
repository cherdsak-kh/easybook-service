import { ApiProperty } from '@nestjs/swagger';

/**
 * The compact registration summary embedded in each admin `GET /line-users` row, so an admin
 * approves a *person* rather than a bare LINE handle. `phone` is included so admins can vet a
 * registration by contacting the applicant — a deliberate reversal of the earlier PII-minimisation
 * decision, at the product owner's request.
 */
export class LineUserRegistrationSummaryDto {
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
}
