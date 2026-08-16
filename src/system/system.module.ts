import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemController } from './system.controller';

/**
 * Build metadata for the version screen. No provider and no state — the controller reads three
 * environment variables.
 *
 * It imports `AuthModule` for one reason: `SessionGuard`. That is the same dependency every
 * session-guarded controller has, and it is what keeps the build string off the public surface.
 */
@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [SystemController],
})
export class SystemModule {}
