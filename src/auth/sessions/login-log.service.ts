import { Injectable, Logger } from '@nestjs/common';
import { LoginEventStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IP_MAX_LENGTH, LOGIN_LOG_RETENTION_DAYS } from './sessions.constants';
import type { LoginHistoryPageDto } from './dto/login-history.dto';
import { parseUserAgent, sanitizeUa } from './user-agent';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * LOGIN-SESSIONS-1 — the only writer and reader of `system_user_login_logs`.
 *
 * PDPA: `ipAddress` + `userAgent` are personal data (purpose: account security, retention: 90 days).
 * Never log a row's IP or UA; log ids and counts only. Rows are never exported and never feed
 * ประวัติการทำรายการ.
 *
 * Retention is enforced twice: `purgeExpired()` (daily cron) deletes, and EVERY read filters
 * `createdAt >= retentionCutoff()`, so a late purge can never surface a 91-day row (AC-19).
 */
@Injectable()
export class LoginLogService {
  private readonly logger = new Logger(LoginLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** `now − 90 days`. */
  retentionCutoff(now: Date = new Date()): Date {
    return new Date(now.getTime() - LOGIN_LOG_RETENTION_DAYS * DAY_MS);
  }

  /** Best-effort: a failed audit insert must never fail a login that already succeeded. Never rejects. */
  async recordSuccess(
    userId: string,
    ip: string,
    userAgent: string,
    sessionRef: string,
  ): Promise<void> {
    await this.insertQuietly(userId, {
      status: LoginEventStatus.SUCCESS,
      ipAddress: this.clipIp(ip),
      userAgent: sanitizeUa(userAgent),
      sessionRef,
    });
  }

  /**
   * A recognised account's rejected login. Called FIRE-AND-FORGET from `validateCredentials` (R-8: no
   * branch-dependent await on the response path), so it must never reject — an unhandled rejection from a
   * detached promise would take the process down.
   */
  async recordFailure(
    userId: string,
    ip: string,
    userAgent: string,
  ): Promise<void> {
    await this.insertQuietly(userId, {
      status: LoginEventStatus.FAILED_BAD_PASSWORD,
      ipAddress: this.clipIp(ip),
      userAgent: sanitizeUa(userAgent),
    });
  }

  /**
   * One row per force sign-out (not per session), against the TARGET, with the SUPER_ADMIN as `actorId`.
   * No IP/UA: the actor's address is not the target's business (R-10). THROWS on failure — the caller
   * (`StaffSessionsService`) decides that the security action already happened and logs instead.
   */
  async recordForceRevoked(
    targetUserId: string,
    actorId: string,
  ): Promise<void> {
    await this.prisma.systemUserLoginLog.create({
      data: {
        systemUserId: targetUserId,
        status: LoginEventStatus.FORCE_REVOKED,
        actorId,
      },
      select: { id: true },
    });
  }

  /** E4. Own rows only, last 90 days, `createdAt DESC, id DESC`. `actorId` and `sessionRef` never leave. */
  async listOwn(
    userId: string,
    page: number,
    limit: number,
    currentHandle: string,
  ): Promise<LoginHistoryPageDto> {
    const where = {
      systemUserId: userId,
      createdAt: { gte: this.retentionCutoff() },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.systemUserLoginLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          createdAt: true,
          ipAddress: true,
          userAgent: true,
          sessionRef: true,
        },
      }),
      this.prisma.systemUserLoginLog.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        device:
          row.status === LoginEventStatus.FORCE_REVOKED
            ? null
            : parseUserAgent(row.userAgent ?? ''),
        ipAddress: row.ipAddress,
        isCurrentSession:
          row.status === LoginEventStatus.SUCCESS &&
          row.sessionRef !== null &&
          row.sessionRef === currentHandle,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  /** The newest row of one status within the retention window (E5). */
  latest(
    userId: string,
    status: LoginEventStatus,
  ): Promise<{
    createdAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  } | null> {
    return this.prisma.systemUserLoginLog.findFirst({
      where: {
        systemUserId: userId,
        status,
        createdAt: { gte: this.retentionCutoff() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, ipAddress: true, userAgent: true },
    });
  }

  /** The daily purge (AC-20): everything older than 90 days, nothing newer. Returns the number deleted. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.systemUserLoginLog.deleteMany({
      where: { createdAt: { lt: this.retentionCutoff(now) } },
    });
    return count;
  }

  private clipIp(ip: string): string {
    return ip.slice(0, IP_MAX_LENGTH);
  }

  private async insertQuietly(
    userId: string,
    data: {
      status: LoginEventStatus;
      ipAddress: string;
      userAgent: string;
      sessionRef?: string;
    },
  ): Promise<void> {
    try {
      await this.prisma.systemUserLoginLog.create({
        data: { systemUserId: userId, ...data },
        select: { id: true },
      });
    } catch (error) {
      // id + error class only. A Prisma error MESSAGE can echo the arguments of the failed call, and
      // those are the IP and the User-Agent.
      const rawCode = (error as { code?: unknown } | null)?.code;
      const reason =
        typeof rawCode === 'string'
          ? rawCode
          : error instanceof Error
            ? error.name
            : 'unknown';
      this.logger.warn(
        `Could not record a login event. id=${userId} status=${data.status} reason=${reason}`,
      );
    }
  }
}
