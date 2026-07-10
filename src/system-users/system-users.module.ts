import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemUsersController } from './system-users.controller';
import { SystemUsersService } from './system-users.service';

/** `AuthModule` supplies `SessionGuard`, `RolesGuard` and `PasswordService`. */
@Module({
  imports: [AuthModule],
  controllers: [SystemUsersController],
  providers: [SystemUsersService],
  exports: [SystemUsersService],
})
export class SystemUsersModule {}
