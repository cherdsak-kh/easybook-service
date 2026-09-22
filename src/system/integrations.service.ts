import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LineCredentialsService } from '../line/line-credentials.service';
import { LineCallError } from '../line/line-call-error';
import { LineService, type LineBotInfo } from '../line/line.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { R2StorageService } from '../storage/r2-storage.service';
import type {
  DatabaseHealthDto,
  IntegrationErrorCode,
  LineVerifyResponseDto,
  RedisHealthDto,
  StorageProbeResponseDto,
  SystemIntegrationsResponseDto,
  UpdateLineIntegrationDto,
} from './dto/integrations.dto';
import { SwaggerGateService } from './swagger-gate.service';

/** `database.status` flips from `ok` to `degraded` at this latency. */
export const DB_DEGRADED_MS = 200;
/** Cap for each infrastructure check — the page waits on GET, so nothing here may hang it. */
export const HEALTH_TIMEOUT_MS = 2_000;

export const LINE_UPDATE_EMPTY_MESSAGE =
  'ต้องระบุค่าที่ต้องการเปลี่ยนอย่างน้อยหนึ่งค่า';
export const LINE_NOT_CONFIGURED_MESSAGE =
  'ยังไม่ได้ตั้งค่า LINE หรือ Channel Access Token ไม่ถูกต้อง';
export const LINE_UNAVAILABLE_MESSAGE =
  'ติดต่อ LINE ไม่ได้ชั่วคราว ลองใหม่อีกครั้ง';

type HttpExceptionClass = new (response?: string | object) => HttpException;

/** The house error body plus a `code` — the same helper shape announcements and canned replies use. */
function codedError(
  Exception: HttpExceptionClass,
  code: IntegrationErrorCode,
  message: string,
): HttpException {
  const base = new Exception(message).getResponse() as Record<string, unknown>;
  return new Exception({ ...base, code });
}

/** Resolves to how long `task` took, or rejects after `ms`. The timer is always cleared. */
async function timed(
  task: () => Promise<unknown>,
  ms: number,
): Promise<number> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      task(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return Date.now() - started;
  } finally {
    clearTimeout(timer);
  }
}

/** Drops `markAsReadMode` — the published `LineBotInfoDto` has four fields. */
const toBotInfoDto = (info: LineBotInfo) => ({
  basicId: info.basicId,
  displayName: info.displayName,
  pictureUrl: info.pictureUrl,
  chatMode: info.chatMode,
});

/**
 * การเชื่อมต่อระบบ — `/api/v1/system/integrations` (`INTEGRATIONS-API-1`).
 *
 * Reads are fail-soft (plan D-5): `overview()` answers 200 with `null` / `error` fields when LINE,
 * Postgres or Redis misbehave — the page must render exactly when something is down, which is when
 * it is opened. `verifyLine()` is the strict call: its whole job is a yes/no, so a no is a 503.
 *
 * 🔴 NOTHING HERE SENDS A LINE MESSAGE. Bot info and the two quota calls are reads and cost no
 * quota; a test push would spend the school's monthly allowance to prove what a read proves free.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly gate: SwaggerGateService,
    private readonly line: LineService,
    private readonly credentials: LineCredentialsService,
    private readonly storage: R2StorageService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async overview(): Promise<SystemIntegrationsResponseDto> {
    const configured = this.credentials.isConfigured();
    const [botInfo, quota, database, redis] = await Promise.all([
      configured ? this.line.getBotInfo().catch(() => null) : null,
      configured ? this.line.getMessageQuota().catch(() => null) : null,
      this.databaseHealth(),
      this.redisHealth(),
    ]);
    const storageConfigured = this.storage.isConfigured();
    return {
      swagger: { enabled: this.gate.isEnabled() },
      line: {
        configured,
        channelId: this.credentials.maskedChannelId(),
        botInfo: botInfo ? toBotInfoDto(botInfo) : null,
        quota,
      },
      storage: {
        configured: storageConfigured,
        bucket: this.config.get<string>('R2_BUCKET') || null,
        publicBaseUrl: this.storage.publicBaseUrl() || null,
      },
      infrastructure: { database, redis },
    };
  }

  async setSwagger(
    enabled: boolean,
  ): Promise<{ success: true; enabled: boolean }> {
    return { success: true, enabled: await this.gate.set(enabled) };
  }

  async updateLine(
    dto: UpdateLineIntegrationDto,
  ): Promise<{ success: true; maskedChannelId: string | null }> {
    const { channelId, channelSecret, channelAccessToken } = dto;
    if (
      channelId === undefined &&
      channelSecret === undefined &&
      channelAccessToken === undefined
    ) {
      throw codedError(
        BadRequestException,
        'LINE_UPDATE_EMPTY',
        LINE_UPDATE_EMPTY_MESSAGE,
      );
    }
    await this.credentials.update({
      channelId,
      channelSecret,
      channelAccessToken,
    });
    return {
      success: true,
      maskedChannelId: this.credentials.maskedChannelId(),
    };
  }

  async verifyLine(): Promise<LineVerifyResponseDto> {
    try {
      const [botInfo, quota] = await Promise.all([
        this.line.getBotInfo(),
        this.line.getMessageQuota(),
      ]);
      return { valid: true, botInfo: toBotInfoDto(botInfo), quota };
    } catch (err) {
      if (err instanceof LineCallError && err.kind === 'NOT_CONFIGURED') {
        throw codedError(
          ServiceUnavailableException,
          'LINE_NOT_CONFIGURED',
          LINE_NOT_CONFIGURED_MESSAGE,
        );
      }
      throw codedError(
        ServiceUnavailableException,
        'LINE_UNAVAILABLE',
        LINE_UNAVAILABLE_MESSAGE,
      );
    }
  }

  probeStorage(): Promise<StorageProbeResponseDto> {
    return this.storage.probe();
  }

  private async databaseHealth(): Promise<DatabaseHealthDto> {
    const started = Date.now();
    try {
      const latencyMs = await timed(
        () => this.prisma.$queryRaw`SELECT 1`,
        HEALTH_TIMEOUT_MS,
      );
      return {
        status: latencyMs >= DB_DEGRADED_MS ? 'degraded' : 'ok',
        latencyMs,
      };
    } catch {
      return { status: 'error', latencyMs: Date.now() - started };
    }
  }

  private async redisHealth(): Promise<RedisHealthDto> {
    const started = Date.now();
    // `isHealthy()` carries its own ping timeout and never throws.
    const up = await this.redis.isHealthy();
    return { status: up ? 'up' : 'down', latencyMs: Date.now() - started };
  }
}
