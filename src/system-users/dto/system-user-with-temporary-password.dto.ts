import { ApiProperty } from '@nestjs/swagger';
import { SystemUserResponseDto } from './system-user-response.dto';

/**
 * The response of the two endpoints that ISSUE a temporary password:
 * `POST /system-users` (201) and `POST /system-users/:id/reset-password` (200). Nothing else.
 *
 * A flat `extends`, not a `{ user, temporaryPassword }` wrapper: the frontend's existing create path
 * reads `data.id` / `data.email` directly, and a wrapper would break every caller for no gain.
 *
 * The plaintext exists only between generation and this response (AC-B7): it is argon2id-hashed into
 * `passwordHash` and NEVER written to any column, NEVER logged, and NEVER retrievable again. A second
 * read of the same user returns `SystemUserResponseDto` — no `temporaryPassword` field at all.
 */
export class SystemUserWithTemporaryPasswordDto extends SystemUserResponseDto {
  @ApiProperty({
    example: 'Kp7Rn2Tq9Wx4Yb6C',
    description:
      'SHOWN EXACTLY ONCE. Not stored in plaintext, not retrievable, not logged. Deliver it out-of-band; the recipient must change it at first login.',
  })
  temporaryPassword!: string;
}
