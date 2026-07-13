import { ApiProperty } from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';

/**
 * Deliberately narrow: `id`, `email`, `firstName`, `lastName`, `role`. The client rehydrates the full profile from
 * `GET /auth/system/me`, which is the one canonical profile shape. Widening this would create a
 * second, drifting profile DTO for no benefit. Never contains a token — the session is a cookie.
 */
export class LoginResponseDto {
  @ApiProperty({ example: 'clx1a2b3c4d5e6f7g8h9i0j1' })
  id!: string;

  @ApiProperty({ example: 'admin@easybook.local' })
  email!: string;

  @ApiProperty({ example: 'Ada' })
  firstName!: string;

  @ApiProperty({ example: 'Lovelace' })
  lastName!: string;

  @ApiProperty({ enum: SystemRole, example: SystemRole.ADMIN })
  role!: SystemRole;
}
