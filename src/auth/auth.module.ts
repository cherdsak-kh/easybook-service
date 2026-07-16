import { Module, forwardRef } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { SystemUsersModule } from '../system-users/system-users.module';
import { AuthSystemController } from './auth-system.controller';
import { AuthService } from './auth.service';
import { AvatarUploadService } from './avatar-upload.service';
import { PasswordService } from './password.service';
import { RolesGuard } from './guards/roles.guard';
import { SessionGuard } from './guards/session.guard';

/**
 * `PrismaModule`, `RedisModule`, `CsrfModule` and the throttler are global, so nothing needs
 * importing here. The guards are exported so `SystemUsersModule` resolves the same classes.
 *
 * `forwardRef(() => SystemUsersModule)` resolves a genuine circular reference, not a design smell:
 * `SystemUsersModule` needs this module's guards, and `AuthSystemController` needs
 * `SystemUsersService` (which owns every `SystemUser` write — `PATCH me` and the avatar's
 * `profilePictureUrl` included). The alternative, re-providing `SystemUsersService` here, would mint
 * a SECOND instance and is exactly the drift `PUBLIC_FIELDS` exists to prevent.
 */
@Module({
  imports: [forwardRef(() => SystemUsersModule), StorageModule],
  controllers: [AuthSystemController],
  providers: [
    AuthService,
    PasswordService,
    AvatarUploadService,
    SessionGuard,
    RolesGuard,
  ],
  exports: [AuthService, PasswordService, SessionGuard, RolesGuard],
})
export class AuthModule {}
