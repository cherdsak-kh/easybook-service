import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemUsersController } from './system-users.controller';
import { SystemUsersService } from './system-users.service';

/**
 * `AuthModule` supplies `SessionGuard`, `RolesGuard` and `PasswordService`.
 *
 * `forwardRef` because `AuthModule` needs `SystemUsersService` back (its controller owns
 * `PATCH /auth/system/me` and the avatar route, whose DB writes belong to this service).
 */
@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [SystemUsersController],
  providers: [SystemUsersService],
  exports: [SystemUsersService],
})
export class SystemUsersModule {}
