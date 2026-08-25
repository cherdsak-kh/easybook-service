import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AmenitiesController } from './amenities.controller';
import { AmenitiesService } from './amenities.service';

/**
 * `Amenity` (อุปกรณ์ที่ให้บริการ) admin CRUD. Its own module rather than a second controller on
 * `VenueTypesModule`: the two tables share a screen and a response shape, not a service — this one
 * has no reserved rows, no tombstone, and a delete that destroys join rows instead of re-pointing
 * holders.
 */
@Module({
  imports: [AuthModule],
  controllers: [AmenitiesController],
  providers: [AmenitiesService],
  exports: [AmenitiesService],
})
export class AmenitiesModule {}
