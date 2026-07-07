import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { LineModule } from './line/line.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    PrismaModule,
    HealthModule,
    LineModule,
    // Domain modules (ResourceModule, BookingModule, ...) are added in their own tasks.
  ],
})
export class AppModule {}
