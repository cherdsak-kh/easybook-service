import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DepartmentsController } from './departments.controller';
import { OptionsService } from './options.service';
import { PersonnelRolesController } from './personnel-roles.controller';

/**
 * Admin CRUD for the two registration option tables. `AuthModule` supplies `SessionGuard` and
 * `RolesGuard` (the same guard stack as `/system-users`). `PrismaModule` is global.
 */
@Module({
  imports: [AuthModule],
  controllers: [DepartmentsController, PersonnelRolesController],
  providers: [OptionsService],
  exports: [OptionsService],
})
export class OptionsModule {}
