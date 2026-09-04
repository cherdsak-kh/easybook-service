import { Module } from '@nestjs/common';
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import { AdminBookingsService } from './admin-bookings.service';
import { BookingRequestsController } from './booking-requests.controller';
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
 * ── THE ADMIN HALF (`BookingRequestsController` + `AdminBookingsService`) ──
 * Added by Phase 4-E and still importing nothing: `SessionGuard` and `RolesGuard` are applied with
 * `@UseGuards` on the controller and resolve their own dependencies (`PrismaService`, `Reflector`),
 * both of which are global — so no `AuthModule` import, which would drag `StorageModule` and
 * `SystemUsersModule` in behind it for two guards.
 *
 * ⚠️ IT IS A SECOND SERVICE, NOT MORE METHODS ON `BookingsService`. That file is past 900 lines and
 * its spec has to stay green without being edited (plan §5). What the two genuinely share was
 * EXTRACTED rather than duplicated: `booking-overlap.ts` (the single owner of the overlap rule,
 * AC-BR19) and `booking-code.ts` (the `BR-…` sequence). Neither is a provider — both are pure
 * function modules taking the caller's transaction client, so there is no instance to substitute and
 * no way for one caller to get a different overlap rule from the other.
 *
 * ⚠️ `BookingRequestsController` IS REGISTERED SECOND, and unlike the LINE pair that is not
 * load-bearing: `/booking-requests` and `/line-users/bookings` share no prefix. The ordering that
 * DOES matter is inside the controller — `direct` above `:id`.
 *
 * `BookingsService` is exported for callers outside this module; `AdminBookingsService` is not,
 * because nothing outside the admin controller has any business approving a booking.
 */
@Module({
  controllers: [LineBookingsController, BookingRequestsController],
  providers: [BookingsService, AdminBookingsService, LineIdTokenGuard],
  exports: [BookingsService],
})
export class BookingsModule {}
