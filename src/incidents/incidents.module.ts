import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { IncidentCaptureFilter } from './incident-capture.filter';
import { IncidentRecorder } from './incident-recorder.service';
import { IncidentStore } from './incident-store';
import { IncidentsController } from './incidents.controller';
import { INCIDENT_KEY_ROOT, incidentKeyRootFor } from './incidents.constants';
import { IncidentsService } from './incidents.service';
import { RequestMetrics } from './request-metrics';

/**
 * Hub 6 (บันทึกข้อผิดพลาด): trace ids, incident capture, the Redis store and the SUPER_ADMIN read side.
 *
 * `@Global()` like `RedisModule`, so `LineService`, `R2StorageService` and `RedisService` can take the
 * recorder as an `@Optional()` constructor parameter without importing this module (which would make a
 * module cycle with `RedisModule`).
 */
@Global()
@Module({
  controllers: [IncidentsController],
  providers: [
    {
      provide: INCIDENT_KEY_ROOT,
      useFactory: (): string => incidentKeyRootFor(process.env.NODE_ENV),
    },
    {
      provide: IncidentStore,
      inject: [REDIS_CLIENT, INCIDENT_KEY_ROOT],
      useFactory: (redis: Redis, root: string): IncidentStore =>
        new IncidentStore(redis, root),
    },
    IncidentRecorder,
    RequestMetrics,
    IncidentsService,
    { provide: APP_FILTER, useClass: IncidentCaptureFilter },
  ],
  exports: [IncidentRecorder, RequestMetrics, IncidentStore],
})
export class IncidentsModule {}
