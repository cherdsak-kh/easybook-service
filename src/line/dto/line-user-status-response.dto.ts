import { ApiProperty } from '@nestjs/swagger';
import { AppAccess } from '@prisma/client';
import { LineUserRegistrationResponseDto } from './line-user-registration-response.dto';

/**
 * The caller's own status view returned by `POST /line-users/register` and
 * `GET /line-users/status`.
 *
 * `access` drives the client portal's four-way screen routing (UNREGISTERED / PENDING / ALLOWED /
 * BLOCKED); `registration` echoes what the user submitted (null before they register).
 */
export class LineUserStatusResponseDto {
  @ApiProperty({ enum: AppAccess, example: AppAccess.PENDING })
  access!: AppAccess;

  @ApiProperty({ type: LineUserRegistrationResponseDto, nullable: true })
  registration!: LineUserRegistrationResponseDto | null;
}
