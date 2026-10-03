import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ReportsActivityController } from './reports-activity.controller';
import { ReportsActivityService } from './reports-activity.service';
import { ReportsController } from './reports.controller';
import { ReportsExportController } from './reports-export.controller';
import { ReportsExportService } from './reports-export.service';
import { ReportsService } from './reports.service';

/**
 * Hub 7 (ภาพรวมระบบ) + Hub 1 (ภาพรวมสถิติเชิงบริหาร) — Reports Phase 1 (design §2.1), plus Hub 4
 * (ส่งออกรายงานราชการ) and Hub 5 (ประวัติการทำรายการ) from Phase 3. Hub 6 lives in `IncidentsModule`.
 *
 * ⚠️ NO `imports`. Both services read Prisma (global) directly and import `booking-list-view.ts` /
 * `booking-code.ts` / `booking-settings.ts` / `bookings.constants.ts` as PLAIN FUNCTIONS, never
 * `BookingsModule` — this module is read-only and must stay isolated from the write-heavy
 * transactional module (spec §5.1's "isolated from write-heavy transactional modules", design §2.1).
 * `SessionGuard`/`RolesGuard` resolve via Nest's global providers, the same pattern `BookingsModule`
 * itself uses, so no `AuthModule` import is needed either.
 */
@Module({
  controllers: [
    DashboardController,
    ReportsController,
    ReportsExportController,
    ReportsActivityController,
  ],
  providers: [
    DashboardService,
    ReportsService,
    ReportsExportService,
    ReportsActivityService,
  ],
})
export class ReportsModule {}
