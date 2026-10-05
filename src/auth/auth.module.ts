import { Module, forwardRef } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { SCHEDULING_ENABLED } from '../common/scheduling.constants';
import { StorageModule } from '../storage/storage.module';
import { SystemUsersModule } from '../system-users/system-users.module';
import { AuthSystemController } from './auth-system.controller';
import { AuthService } from './auth.service';
import { AvatarUploadService } from './avatar-upload.service';
import { PasswordService } from './password.service';
import { RolesGuard } from './guards/roles.guard';
import { SessionGuard } from './guards/session.guard';
import { AuthSessionsController } from './sessions/auth-sessions.controller';
import { LoginLogPurgeCron } from './sessions/login-log-purge.cron';
import { LoginLogService } from './sessions/login-log.service';
import { SessionTrackerService } from './sessions/session-tracker.service';
import { SessionsService } from './sessions/sessions.service';
import { StaffSessionsService } from './sessions/staff-sessions.service';

/**
 * `LoginLogPurgeCron` (LOGIN-SESSIONS-1, 90-day login-history retention) is registered here, next to the
 * service it calls, behind the single `SCHEDULING_ENABLED` — under jest it is absent from the module graph.
 */
const schedulingProviders: Provider[] = SCHEDULING_ENABLED
  ? [LoginLogPurgeCron]
  : [];

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
  // `AuthSessionsController` after `AuthSystemController`: it holds the only parameterised route under
  // `auth/system`, and it registers `sessions/others` before `sessions/:handle`.
  controllers: [AuthSystemController, AuthSessionsController],
  providers: [
    AuthService,
    PasswordService,
    AvatarUploadService,
    SessionGuard,
    RolesGuard,
    // LOGIN-SESSIONS-1. The tracker is deliberately NOT exported: `SessionGuard` must not depend on it
    // (it may only use global providers — five modules use the guard without importing this module).
    SessionTrackerService,
    LoginLogService,
    SessionsService,
    StaffSessionsService,
    ...schedulingProviders,
  ],
  exports: [
    AuthService,
    PasswordService,
    SessionGuard,
    RolesGuard,
    StaffSessionsService,
  ],
})
export class AuthModule {}
