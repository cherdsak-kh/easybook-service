import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { resolveAppVersion } from '../../common/app-version';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminNotificationTriggers } from './admin-notification-triggers.service';
import { LAST_ANNOUNCED_VERSION_KEY } from './triggers.constants';

const DOTTED_NUMBER = /^\d+(\.\d+)*$/;

/** Strips one leading `v`, e.g. `v0.8.0` → `0.8.0`. */
const stripV = (v: string): string => (v.startsWith('v') ? v.slice(1) : v);

/**
 * `true` only when BOTH values parse as dotted numbers and `next` is numerically smaller than
 * `previous`, segment by segment (design §2.8). A non-numeric stamp on either side counts as
 * "changed", never as a downgrade.
 */
export function isDowngrade(previous: string, next: string): boolean {
  const a = stripV(previous);
  const b = stripV(next);
  if (!DOTTED_NUMBER.test(a) || !DOTTED_NUMBER.test(b)) return false;
  const as = a.split('.').map(Number);
  const bs = b.split('.').map(Number);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i] ?? 0;
    const y = bs[i] ?? 0;
    if (x !== y) return y < x;
  }
  return false; // equal versions — not a downgrade (and unreachable via the `row.value === current` skip)
}

/**
 * C2 — announces a version change exactly once per deploy, across however many instances boot
 * (design §2.8). Registered as a provider ONLY when `SCHEDULING_ENABLED` (the same "guard the
 * registration, not the handler body" rule every cron in this app follows) — so it is absent from
 * the module graph under jest, `AC-10` holds trivially, and no `OnApplicationBootstrap` hook ever
 * fires in a test run.
 */
@Injectable()
export class VersionAnnouncer implements OnApplicationBootstrap {
  private readonly logger = new Logger(VersionAnnouncer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly triggers: AdminNotificationTriggers,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** Non-blocking (`void`) — a DB outage must never delay `listen()`. */
  onApplicationBootstrap(): void {
    void this.announce();
  }

  async announce(current: string = resolveAppVersion()): Promise<void> {
    try {
      // `scripts/setup-rich-menu.ts` boots `AppModule` via `createApplicationContext`, which has no
      // HTTP adapter — a CLI run must never announce.
      if (!this.adapterHost.httpAdapter) return;
      if (current === '0.0.0') return;

      const row = await this.prisma.appSetting.findUnique({
        where: { key: LAST_ANNOUNCED_VERSION_KEY },
        select: { value: true },
      });

      if (row === null) {
        // First boot on a fresh DB — record silently, never announce "a new version".
        await this.prisma.appSetting.createMany({
          data: [
            {
              key: LAST_ANNOUNCED_VERSION_KEY,
              value: current,
              description:
                'Last app version announced to operators (C2). Written by VersionAnnouncer only.',
            },
          ],
          skipDuplicates: true,
        });
        return;
      }

      if (row.value === current) return;

      // Conditional swap — exactly one instance wins the race and notifies.
      const { count } = await this.prisma.appSetting.updateMany({
        where: { key: LAST_ANNOUNCED_VERSION_KEY, value: row.value },
        data: { value: current },
      });
      if (count !== 1) return;

      if (isDowngrade(row.value, current)) return;

      await this.triggers.versionChanged({ previous: row.value, current });
    } catch (error) {
      this.logger.warn(
        `Version announcement skipped: ${
          error instanceof Error ? error.constructor.name : 'UnknownError'
        }`,
      );
    }
  }
}
