import { Module } from '@nestjs/common';
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import { BookingsService } from './bookings.service';
import { LineBookingsController } from './line-bookings.controller';

/**
 * `CLIENT-BOOKING-1` — the booking domain, client half.
 *
 * ⚠️ IT IMPORTS NOTHING, and each absence is a decision:
 *
 * - **No `PrismaModule`** — it is `@Global()`, so `PrismaService` injects without an import. Every
 *   feature module here does the same.
 * - **No `LineModule`**, even though the controller uses `LineIdTokenGuard`. The guard is listed as
 *   a provider below rather than imported, because `LineModule` does not export it — and importing
 *   that module for one guard would drag `RealtimeModule` and `VenuesModule` in behind it and make
 *   this module's dependency graph a lie about what it needs. `LineIdTokenGuard` depends only on
 *   `ConfigService` (global), so a second instance costs nothing and shares no state: it is a pure
 *   verifier that holds no cache and no connection.
 * - **No `VenuesModule`** — this service reads `Venue` for two booleans (`deletedAt`, `isOpen`) and
 *   one name, inside the same transaction as the write. `VenuesService.findById` would run outside
 *   it and return the full public DTO, which is the wrong shape and the wrong moment.
 *
 * `BookingsService` is exported because Phase 5a's second half — the admin approval and direct
 * booking surface — will add a `SessionGuard` controller that shares its transaction logic.
 */
@Module({
  controllers: [LineBookingsController],
  providers: [BookingsService, LineIdTokenGuard],
  exports: [BookingsService],
})
export class BookingsModule {}
