import { Module } from '@nestjs/common';
import { AuthSystemController } from './auth-system.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RolesGuard } from './guards/roles.guard';
import { SessionGuard } from './guards/session.guard';

/**
 * `PrismaModule`, `RedisModule`, `CsrfModule` and the throttler are global, so nothing needs
 * importing here. The guards are exported so `SystemUsersModule` resolves the same classes.
 */
@Module({
  controllers: [AuthSystemController],
  providers: [AuthService, PasswordService, SessionGuard, RolesGuard],
  exports: [AuthService, PasswordService, SessionGuard, RolesGuard],
})
export class AuthModule {}
