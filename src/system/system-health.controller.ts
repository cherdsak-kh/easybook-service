import { Controller, Get, UseGuards } from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedSystemUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import type { Actor } from '../system-users/system-users.policy';
import { SystemHealthResponseDto } from './dto/system-health.dto';
import { SystemHealthService } from './system-health.service';

const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
  createdById: user.createdBy?.id ?? null,
});

/**
 * `GET /api/v1/system/health` — role-shaped infrastructure health for card 4 + the system strip
 * (design §2.4, R-3: distinct from the public, unauthenticated `GET /health` readiness probe, which
 * this route neither calls nor replaces).
 *
 * ⚠️ `/system/health` IS SESSION-GUARDED — `SESSION_EXEMPT_PATHS` matches `/health` EXACTLY
 * (`session.middleware.ts`), so this longer path is unaffected and requires a live session like any
 * other back-office route.
 */
@ApiTags('System')
@ApiCookieAuth('session')
@Controller('system/health')
@UseGuards(SessionGuard, RolesGuard)
export class SystemHealthController {
  constructor(private readonly health: SystemHealthService) {}

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'Database / LINE / R2 health, role-shaped.',
    description:
      'Always 200 — a probe failure is a DOWN chip, never a 5xx (AC-D19). SUPER_ADMIN gets `detail: FULL` with numeric telemetry (latency, LINE quota, R2 probe latency); ADMIN and VIEWER get `detail: SUMMARY` with `telemetry: null` — the server never builds those numbers for them (AC-D17). LINE and R2 probes are cached for up to 300 s success / 60 s failure; the DB probe runs live every call.',
  })
  @ApiOkResponse({ type: SystemHealthResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'CSRF failure (n/a on GET), or a forced password change is pending.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  check(
    @CurrentUser() user: AuthenticatedSystemUser,
  ): Promise<SystemHealthResponseDto> {
    return this.health.check(actorOf(user));
  }
}
