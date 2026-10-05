import {
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SystemRole } from '@prisma/client';
import { memoryStorage } from 'multer';
import type { AuthenticatedSystemUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import {
  SupportCodedErrorDto,
  SupportIncidentDto,
  SupportIncidentFormDto,
  SupportIncidentResponseDto,
} from './dto/support-incident.dto';
import { SupportRelayService } from './support-relay.service';
import { SupportUploadErrorFilter } from './support-upload.filter';
import {
  SUPPORT_FILE_MULTER_SIZE_LIMIT,
  SUPPORT_FILES_MAX,
} from './support.constants';

/**
 * `POST /api/v1/system/support/incident` — the admin portal's ติดต่อทีมผู้พัฒนา form, relayed to the dev
 * team's Discord. Named `support-*` on purpose: `src/incidents/` is the unrelated Hub 6 error-log
 * pipeline and this is never wired into `IncidentsModule`.
 *
 * CSRF is the app-wide `x-csrf-token` middleware (this path is NOT in `CSRF_EXEMPT_PATHS`), and the
 * route is not exempt from the forced-password-change gate. All logic lives in `SupportRelayService`.
 */
@ApiTags('System')
@ApiCookieAuth('session')
@Controller('system/support')
@UseGuards(SessionGuard, RolesGuard)
export class SupportController {
  constructor(private readonly relay: SupportRelayService) {}

  // Guards run before interceptors, so a 401/403 never buffers an upload. memoryStorage: <= 3 x 5 MiB
  // goes straight to Discord and nothing is written to disk.
  @Post('incident')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @UseInterceptors(
    FilesInterceptor('files', SUPPORT_FILES_MAX, {
      storage: memoryStorage(),
      limits: {
        fileSize: SUPPORT_FILE_MULTER_SIZE_LIMIT,
        files: SUPPORT_FILES_MAX,
        fields: 10,
        fieldSize: 16 * 1024,
      },
    }),
  )
  // An INSTANCE, not the class: it is method-scoped and has no injectable dependencies.
  @UseFilters(new SupportUploadErrorFilter())
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: SupportIncidentFormDto })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOperation({
    summary: 'Relay an incident report to the EasyBook dev team (Discord).',
    description:
      'Multipart. Text fields plus 0–3 parts named `files`. Nothing is persisted. The reporter role, name and phone are taken from the session, never the body. Image type is decided by magic-byte sniff, never by the declared MIME. Answers 503 SUPPORT_NOT_CONFIGURED when DISCORD_SUPPORT_WEBHOOK_URL is unset or invalid.',
  })
  @ApiOkResponse({
    type: SupportIncidentResponseDto,
    description:
      'Relayed. `code` is identical to the code in the Discord message heading.',
  })
  @ApiBadRequestResponse({
    type: SupportCodedErrorDto,
    description:
      'Coded for SUPPORT_FILE_TYPE_UNSUPPORTED; validation / multer refusals (bad enum, empty or over-long field, unknown field, 4th file) are the uncoded house body.',
  })
  @ApiUnauthorizedResponse({
    type: ErrorResponseDto,
    description: 'No session.',
  })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description:
      'Missing or invalid CSRF token, or a forced password change is pending.',
  })
  @ApiPayloadTooLargeResponse({
    type: SupportCodedErrorDto,
    description:
      'SUPPORT_FILE_TOO_LARGE (a file > 5 MB) or SUPPORT_ATTACHMENTS_TOO_LARGE (combined size too large, or Discord refused the upload).',
  })
  @ApiTooManyRequestsResponse({
    type: SupportCodedErrorDto,
    description:
      'SUPPORT_RATE_LIMITED: more than 5 reports in 10 minutes for this user.',
  })
  @ApiBadGatewayResponse({
    type: SupportCodedErrorDto,
    description:
      'SUPPORT_RELAY_FAILED: Discord answered non-2xx, the network failed, or the 10 s time-box elapsed.',
  })
  @ApiServiceUnavailableResponse({
    type: SupportCodedErrorDto,
    description:
      'SUPPORT_NOT_CONFIGURED (coded) when the webhook is unset or invalid; the uncoded house body when the session store is down.',
  })
  submit(
    @CurrentUser() user: AuthenticatedSystemUser,
    @Body() dto: SupportIncidentDto,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ): Promise<SupportIncidentResponseDto> {
    return this.relay.submit(user, dto, files);
  }
}
