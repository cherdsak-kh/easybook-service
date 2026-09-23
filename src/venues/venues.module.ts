import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { VenuePhotoUploadService } from './venue-photo-upload.service';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

/**
 * `Venue` (สถานที่จัดกิจกรรม) — the product's subject table, and the first module here that both
 * reads two curated tables and writes to object storage.
 *
 * `StorageModule` is imported for the second reason. Until now `AuthModule` was its only importer
 * (staff avatars); venue photos are the second kind of object in the same bucket, which is why
 * `R2StorageService.putAvatar` became `putImage` and the two size messages moved into their callers.
 *
 * ⚠️ IT DOES NOT IMPORT `VenueTypesModule` OR `AmenitiesModule`, and that is deliberate. This module
 * validates category and amenity ids with its own queries INSIDE the write transaction — an
 * `assert…` on a sibling service would run outside it, and the whole point of the check is that a
 * soft-deleted row still satisfies the FK. The traffic in the other direction is real, though:
 * deleting a category re-points these rows, and deleting an amenity releases its ticks, both from
 * those services.
 */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [VenuesController],
  providers: [VenuesService, VenuePhotoUploadService],
  exports: [VenuesService],
})
export class VenuesModule {}
