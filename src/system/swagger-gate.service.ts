import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/** The `AppSetting` row that holds the runtime answer. `'true'` / `'false'`. */
export const SWAGGER_SETTING_KEY = 'system.swagger_enabled';

/** Parses a stored value. Anything but a clean `true`/`false` is "no answer" — fall back, never throw. */
export function parseSwaggerSetting(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * Whether `/docs`, `/docs-json` and `/docs-yaml` are served RIGHT NOW (`INTEGRATIONS-API-1`).
 *
 * Precedence (plan D-1):
 *   1. the `system.swagger_enabled` row, when it holds `true`/`false` — a SUPER_ADMIN's decision;
 *   2. else `SWAGGER_ENABLED=true` in the environment (dev convenience; `.env.example` sets it);
 *   3. else OFF. Secure by default — an unset variable no longer publishes the contract.
 *
 * ⚠️ THE ANSWER IS A PROCESS-LOCAL BOOLEAN (plan D-2), read on every docs request with no database
 * round trip. `set()` updates the row and the boolean together, so the next request sees the change.
 * EasyBook runs ONE API container; a second replica would keep its own copy until restart. If that
 * day comes, this becomes a Redis pub/sub subscription.
 */
@Injectable()
export class SwaggerGateService implements OnModuleInit {
  private readonly logger = new Logger(SwaggerGateService.name);
  private readonly envDefault: boolean;
  private enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.envDefault =
      config.get<string>('SWAGGER_ENABLED', '').trim().toLowerCase() === 'true';
    this.enabled = this.envDefault;
  }

  async onModuleInit(): Promise<void> {
    try {
      const row = await this.prisma.appSetting.findUnique({
        where: { key: SWAGGER_SETTING_KEY },
      });
      this.enabled = parseSwaggerSetting(row?.value) ?? this.envDefault;
    } catch (err) {
      // Keep the env default rather than fail boot over a settings read.
      this.logger.error(
        `Could not read ${SWAGGER_SETTING_KEY}; using the env default (${(err as Error).name}).`,
      );
    }
    this.logger.log(
      `Swagger UI ${this.enabled ? 'ENABLED' : 'disabled'} at boot.`,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Persist, then flip. The row is written first so a failed write leaves the live state honest. */
  async set(enabled: boolean): Promise<boolean> {
    await this.prisma.appSetting.upsert({
      where: { key: SWAGGER_SETTING_KEY },
      create: {
        key: SWAGGER_SETTING_KEY,
        value: String(enabled),
        description:
          'Serve Swagger UI + OpenAPI JSON at /docs and /docs-json. Toggled at runtime from การเชื่อมต่อระบบ.',
      },
      update: { value: String(enabled) },
    });
    this.enabled = enabled;
    this.logger.log(
      `Swagger UI ${enabled ? 'ENABLED' : 'disabled'} at runtime.`,
    );
    return enabled;
  }

  /**
   * The Express middleware. Mounted on the docs paths BEFORE `SwaggerModule.setup` (see
   * `mountSwagger`). While disabled it answers exactly what Nest answers for any unknown route — the
   * same status, body and headers a scanner would see for a path that never existed — so the gate
   * itself reveals nothing.
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (this.enabled) {
        next();
        return;
      }
      res.status(404).json({
        message: `Cannot ${req.method} ${req.originalUrl.split('?')[0]}`,
        error: 'Not Found',
        statusCode: 404,
      });
    };
  }
}
