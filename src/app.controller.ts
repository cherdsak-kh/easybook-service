import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppInfoResponseDto } from './dto/app-info-response.dto';

/**
 * Public root welcome banner. Route: GET / (served OUTSIDE the `/api/v1` global
 * prefix — see the `exclude` in app.setup.ts).
 *
 * A lightweight "is this thing on?" landing response for anyone hitting the
 * service origin directly. It is NOT a readiness gate: it touches no dependency
 * and always answers `200`. Use GET /api/v1/health for the DB/Redis probe.
 */
@ApiTags('App')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({
    summary: 'Service welcome banner',
    description:
      'Returns a small liveness banner at the service root (no `/api/v1` prefix). ' +
      'For dependency-aware readiness use GET /api/v1/health instead.',
  })
  @ApiOkResponse({
    description: 'The service is up and serving requests.',
    type: AppInfoResponseDto,
  })
  getInfo(): AppInfoResponseDto {
    return {
      message: 'EasyBook API is running',
      status: 'active',
      timestamp: new Date().toISOString(),
    };
  }
}
