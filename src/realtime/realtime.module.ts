import { Module } from '@nestjs/common';
import { ClientRealtimeGateway } from './client-realtime.gateway';
import { RealtimeGateway } from './realtime.gateway';

/**
 * The realtime transport — two namespaces, two gateways, one module.
 *
 * Depends only on the global `PrismaModule` / `ConfigModule` / `RedisModule`, so `LineModule` and
 * `BookingsModule` can import it without a `forwardRef` and inject either gateway directly. Direct
 * injection is deliberate: a `@nestjs/event-emitter` indirection would add a package, a second
 * registry to keep in sync, and a place for an event to be published with nothing listening.
 *
 * ⚠️ `ClientRealtimeGateway` (`/client`) IS NOT A VARIANT OF `RealtimeGateway` (`/admin`) and they
 * share no base class, no handshake and no event vocabulary — only this module and the constants
 * file. See the class comment on `ClientRealtimeGateway` for the three ways they differ.
 *
 * ⚠️ Registering a gateway here is NOT enough to make its namespace reachable: it must also be on
 * `REALTIME_NAMESPACE_ALLOWLIST`, which `SessionIoAdapter` seals. That trip-wire is by design.
 */
@Module({
  providers: [RealtimeGateway, ClientRealtimeGateway],
  exports: [RealtimeGateway, ClientRealtimeGateway],
})
export class RealtimeModule {}
