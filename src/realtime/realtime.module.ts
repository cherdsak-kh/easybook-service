import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/**
 * The realtime transport.
 *
 * Depends only on the global `PrismaModule` / `ConfigModule` / `RedisModule`, so `LineModule` can
 * import it without a `forwardRef` and `LineUserService` can inject `RealtimeGateway` directly.
 * Direct injection is deliberate: a `@nestjs/event-emitter` indirection would add a package, a
 * second registry to keep in sync, and a place for an event to be published with nothing listening.
 */
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
