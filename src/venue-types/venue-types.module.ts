import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VenueTypesController } from './venue-types.controller';
import { VenueTypesService } from './venue-types.service';

/**
 * `VenueType` (ประเภทสถานที่) admin CRUD. `AuthModule` supplies `SessionGuard` and `RolesGuard` —
 * the same stack as `/system-users` and `/departments`. `PrismaModule` and `RedisModule` are global.
 */
@Module({
  imports: [AuthModule],
  controllers: [VenueTypesController],
  providers: [VenueTypesService],
  exports: [VenueTypesService],
})
export class VenueTypesModule {}
