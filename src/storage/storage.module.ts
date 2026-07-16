import { Module } from '@nestjs/common';
import { R2StorageService } from './r2-storage.service';

/**
 * The object-storage seam. `ConfigModule` is global, so nothing needs importing here.
 * `R2StorageService` is exported so `AuthModule` (the avatar route) resolves the same instance.
 */
@Module({
  providers: [R2StorageService],
  exports: [R2StorageService],
})
export class StorageModule {}
