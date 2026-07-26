import { ApiProperty } from '@nestjs/swagger';
import { AppAccess } from '@prisma/client';
import { LineUserRegistrationResponseDto } from './line-user-registration-response.dto';

/**
 * The caller's own status view returned by `POST /line-users/register` and
 * `GET /line-users/status`.
 *
 * `access` drives the client portal's five-way screen routing (UNREGISTERED / PENDING / ALLOWED /
 * BLOCKED / REJECTED); `registration` echoes what the user submitted (null before they register);
 * `rejectionReason` feeds the REJECTED screen (non-null only when `access === REJECTED`).
 */
export class LineUserStatusResponseDto {
  @ApiProperty({ enum: AppAccess, example: AppAccess.PENDING })
  access!: AppAccess;

  @ApiProperty({ type: LineUserRegistrationResponseDto, nullable: true })
  registration!: LineUserRegistrationResponseDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'เบอร์โทรศัพท์ไม่ถูกต้อง กรุณากรอกใหม่',
    description:
      'The operator-authored rejection reason, shown by the LIFF RejectedScreen. Non-null IFF ' +
      '`access === REJECTED`; null for every other state (invariant mirror of LineUser.rejectionReason).',
  })
  rejectionReason!: string | null;
}
