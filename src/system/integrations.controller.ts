import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import {
  IntegrationCodedErrorDto,
  LineVerifyResponseDto,
  SetSwaggerDto,
  SetSwaggerResponseDto,
  StorageProbeResponseDto,
  SystemIntegrationsResponseDto,
  UpdateLineIntegrationDto,
  UpdateLineIntegrationResponseDto,
} from './dto/integrations.dto';
import { IntegrationsService } from './integrations.service';

const NO_SESSION = { description: 'No session.', type: ErrorResponseDto };
const SESSION_STORE_DOWN = {
  description: 'Session store unavailable.',
  type: ErrorResponseDto,
};
const READ_FORBIDDEN = {
  description: 'VIEWER, or password change required.',
  type: ErrorResponseDto,
};
const PROBE_FORBIDDEN = {
  description:
    'VIEWER, CSRF failure (including with no session — CSRF runs before the guards), or password change required.',
  type: ErrorResponseDto,
};
const WRITE_FORBIDDEN = {
  description:
    'ADMIN or VIEWER (SUPER_ADMIN only), CSRF failure (including with no session), or password change required. Nothing is written.',
  type: ErrorResponseDto,
};

/**
 * `การเชื่อมต่อระบบ` — route prefix `/api/v1/system/integrations` (`INTEGRATIONS-API-1`).
 *
 * | Route | SUPER_ADMIN | ADMIN | VIEWER |
 * |---|---|---|---|
 * | `GET /` | ✓ | ✓ | 403 |
 * | `PATCH /swagger`, `PATCH /line` | ✓ | 403 | 403 |
 * | `POST /line/verify`, `POST /storage/probe` | ✓ | ✓ | 403 |
 *
 * VIEWER is refused even the read: all of การตั้งค่าระบบ is an action surface (the app's
 * `VIEWER_DENY`), and this one also names the infrastructure. The probes are POST because they DO
 * something (R2 gets an object written and deleted; LINE gets called), not because they change
 * settings — so ADMIN may run them.
 *
 * CSRF applies to the four non-GET routes through the global middleware; nothing here is exempt.
 */
@ApiTags('System integrations')
@ApiCookieAuth('session')
@Controller('system/integrations')
@UseGuards(SessionGuard, RolesGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary:
      'Connection health and runtime configuration of every external dependency.',
    description:
      'Fail-soft: LINE, PostgreSQL or Redis failing yields `null` / `error` fields in a 200, never a 5xx. Calls LINE `GET /v2/bot/info` and the two quota reads when a token is loaded — no message is sent and no quota is spent. The channel secret and access token are NEVER returned; the Channel ID is masked.',
  })
  @ApiOkResponse({ type: SystemIntegrationsResponseDto })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(READ_FORBIDDEN)
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  overview(): Promise<SystemIntegrationsResponseDto> {
    return this.integrations.overview();
  }

  @Patch('swagger')
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Turn Swagger UI and the OpenAPI JSON on or off, at runtime.',
    description:
      'Persisted to `AppSetting system.swagger_enabled` and applied to the next request — no restart. While off, `/docs`, `/docs/*`, `/docs-json` and `/docs-yaml` answer the same 404 as any unknown route.',
  })
  @ApiOkResponse({ type: SetSwaggerResponseDto })
  @ApiBadRequestResponse({
    description: '`enabled` missing or not a JSON boolean, or an unknown key.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  setSwagger(@Body() dto: SetSwaggerDto): Promise<SetSwaggerResponseDto> {
    return this.integrations.setSwagger(dto.enabled);
  }

  @Patch('line')
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Replace the LINE channel credentials, at runtime.',
    description:
      'Every field optional, at least one required. Omitted fields are kept. Persisted to `AppSetting` (**plaintext** — see the service) and applied at once: a new token replaces the live Messaging client, a new secret verifies the next webhook. Values are never echoed back.',
  })
  @ApiOkResponse({ type: UpdateLineIntegrationResponseDto })
  @ApiBadRequestResponse({
    description:
      '`LINE_UPDATE_EMPTY` (coded) for an empty body. A malformed field (Channel ID not 10 digits, secret not 32 hex, token outside 40–1000 characters or containing whitespace, an unknown key) is the house body with a `string[]` `message` and no `code`.',
    type: IntegrationCodedErrorDto,
  })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(WRITE_FORBIDDEN)
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  updateLine(
    @Body() dto: UpdateLineIntegrationDto,
  ): Promise<UpdateLineIntegrationResponseDto> {
    return this.integrations.updateLine(dto);
  }

  @Post('line/verify')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Prove the channel access token works — without spending quota.',
    description:
      'Calls LINE `GET /v2/bot/info`, `GET /v2/bot/message/quota` and `GET /v2/bot/message/quota/consumption`. Nothing is pushed.',
  })
  @ApiOkResponse({ type: LineVerifyResponseDto })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(PROBE_FORBIDDEN)
  @ApiServiceUnavailableResponse({
    description:
      '`LINE_NOT_CONFIGURED` — no token, or LINE answered 401/403. `LINE_UNAVAILABLE` — a timeout, 5xx, 429 or any other LINE failure. Also the session store being down (no `code`).',
    type: IntegrationCodedErrorDto,
  })
  verifyLine(): Promise<LineVerifyResponseDto> {
    return this.integrations.verifyLine();
  }

  @Post('storage/probe')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Read and write probe against the Cloudflare R2 bucket.',
    description:
      'Always 200. `read`: list one key. `write`: put then delete a two-byte object under `_healthcheck/`. `ok` is both. An unconfigured bucket is all false with `latencyMs` 0. Bucket settings are READ-ONLY here by design — they are baked into every stored object URL.',
  })
  @ApiOkResponse({ type: StorageProbeResponseDto })
  @ApiUnauthorizedResponse(NO_SESSION)
  @ApiForbiddenResponse(PROBE_FORBIDDEN)
  @ApiServiceUnavailableResponse(SESSION_STORE_DOWN)
  probeStorage(): Promise<StorageProbeResponseDto> {
    return this.integrations.probeStorage();
  }
}
