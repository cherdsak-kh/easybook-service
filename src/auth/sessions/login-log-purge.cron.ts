import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LoginLogService } from './login-log.service';

/**
 * Daily at 03:30, server local time — after the 03:00 photo sweep, so the two never overlap. Exported so
 * the spec asserts the EXACT string: a fat-fingered `'30 3 * * 0'` (weekly) is valid cron and throws nothing.
 * No timezone is passed, for the same reason as `ORPHAN_PHOTO_SWEEP_CRON`: 03:30 is outside working hours
 * anywhere this school would deploy, and the job only deletes rows already hidden from every read.
 */
export const LOGIN_LOG_PURGE_CRON = '30 3 * * *';

/**
 * The 90-day retention purge of `system_user_login_logs` (AC-20). Registered by `AuthModule` behind
 * `SCHEDULING_ENABLED` — under jest it is absent from the module graph, because a registered `CronJob` is
 * an open handle in every e2e suite. A guard inside the handler body would not fix that.
 */
@Injectable()
export class LoginLogPurgeCron {
  private readonly logger = new Logger(LoginLogPurgeCron.name);

  constructor(private readonly loginLog: LoginLogService) {}

  /**
   * ⚠️ NOTHING MAY ESCAPE THIS METHOD. A rejection out of a `CronJob` tick has no request to turn it into a
   * 500; Node 20+ terminates the process on an unhandled rejection. A purge that fails is a logged error and
   * a retry tomorrow — and every read filters on the cutoff anyway, so no expired row is ever shown.
   */
  @Cron(LOGIN_LOG_PURGE_CRON)
  async purge(): Promise<void> {
    try {
      const deleted = await this.loginLog.purgeExpired();
      this.logger.log(`Login log purge finished. deleted=${deleted}`);
    } catch (error: unknown) {
      this.logger.error(
        `Login log purge failed; the rows stay eligible for tomorrow's run. reason=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
