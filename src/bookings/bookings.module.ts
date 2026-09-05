import { Module } from '@nestjs/common';
import { LineIdTokenGuard } from '../line/guards/line-id-token.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminBookingsService } from './admin-bookings.service';
import { BookingRequestsController } from './booking-requests.controller';
import { BookingsService } from './bookings.service';
import { LineBookingsController } from './line-bookings.controller';

/**
 * `CLIENT-BOOKING-1` — the booking domain, client half.
 *
 * ⚠️ IT IMPORTS EXACTLY ONE MODULE, and both the one import and the three absences are decisions:
 *
 * - **`RealtimeModule` — THE ONE IMPORT** (`ADMIN-REALTIME-BOOKINGS-1`). It buys `RealtimeGateway`,
 *   the `/admin` Socket.IO fan-out both services emit through so a second operator's queue moves the
 *   instant somebody approves, rejects or cancels — including for the requests ADR-001 auto-rejects,
 *   which belong to *other people* and would otherwise sit stale on every other screen.
 *   ⚠️ IT IS THE EXCEPTION, AND FOR A PRECISE REASON: the three absences below all avoid dragging
 *   TRANSITIVE modules in behind a single dependency. `RealtimeModule` has no transitive cost at all
 *   — it declares `providers: [RealtimeGateway]` / `exports: [RealtimeGateway]` and imports nothing,
 *   standing only on the global `Prisma`/`Config`/`Redis` modules. So the graph stays honest and the
 *   cycle risk is zero (`LineModule` imports it the same way, for the same reason). Do not read this
 *   import as permission to relax the rule below; read it as the rule being applied.
 * - **No `PrismaModule`** — it is `@Global()`, so `PrismaService` injects without an import. Every
 *   feature module here does the same.
 * - **No `LineModule`**, even though the controller uses `LineIdTokenGuard`. The guard is listed as
 *   a provider below rather than imported, because `LineModule` does not export it — and importing
 *   that module for one guard would drag `RealtimeModule` and `VenuesModule` in behind it and make
 *   this module's dependency graph a lie about what it needs. `LineIdTokenGuard` depends only on
 *   `ConfigService` (global), so a second instance costs nothing and shares no state: it is a pure
 *   verifier that holds no cache and no connection. (`RealtimeModule` being imported directly above
 *   changes nothing here: what is refused is arriving at a dependency *sideways*, through a module
 *   that was imported for something else entirely.)
 * - **No `VenuesModule`** — this service reads `Venue` for two booleans (`deletedAt`, `isOpen`) and
 *   one name, inside the same transaction as the write. `VenuesService.findById` would run outside
 *   it and return the full public DTO, which is the wrong shape and the wrong moment.
 *
 * ── THE ADMIN HALF (`BookingRequestsController` + `AdminBookingsService`) ──
 * Added by Phase 4-E, and it still imports no module for its guards: `SessionGuard` and `RolesGuard`
 * are applied with `@UseGuards` on the controller and resolve their own dependencies
 * (`PrismaService`, `Reflector`), both of which are global — so no `AuthModule` import, which would
 * drag `StorageModule` and `SystemUsersModule` in behind it for two guards.
 *
 * ⚠️ IT IS A SECOND SERVICE, NOT MORE METHODS ON `BookingsService`. That file is past 900 lines and
 * its spec has to stay green without being edited (plan §5). What the two genuinely share was
 * EXTRACTED rather than duplicated: `booking-overlap.ts` (the single owner of the overlap rule,
 * AC-BR19), `booking-code.ts` (the `BR-…` sequence), and — since `ADMIN-REALTIME-BOOKINGS-1` —
 * `booking-list-view.ts` (the single owner of the queue-row payload) plus `booking-realtime.ts` (the
 * fail-soft emit). None is a provider: all four are pure function modules taking the caller's client,
 * so there is no instance to substitute and no way for one caller to get a different overlap rule —
 * or a different event payload — from the other.
 *
 * ⚠️ `BookingRequestsController` IS REGISTERED SECOND, and unlike the LINE pair that is not
 * load-bearing: `/booking-requests` and `/line-users/bookings` share no prefix. The ordering that
 * DOES matter is inside the controller — `direct` above `:id`.
 *
 * `BookingsService` is exported for callers outside this module; `AdminBookingsService` is not,
 * because nothing outside the admin controller has any business approving a booking.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [LineBookingsController, BookingRequestsController],
  providers: [BookingsService, AdminBookingsService, LineIdTokenGuard],
  exports: [BookingsService],
})
export class BookingsModule {}
