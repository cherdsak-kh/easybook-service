import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SessionGuard } from '../auth/guards/session.guard';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { VersionResponseDto } from './dto/version-response.dto';

/**
 * Build metadata for the version screen. Route: `GET /api/v1/system/version`
 *
 * ⚠️ THIS DOES NOT BELONG ON `/health`, and the temptation is real because the probe already
 * returns a small JSON blob about the running service. `/health` is PUBLIC and unauthenticated —
 * that is what lets a load balancer use it — and publishing an exact build to the open internet is
 * how a scanner matches a published CVE to a specific deployment. Behind the session guard, the
 * same string is only visible to people who could read it off the screen anyway.
 *
 * The frontend half of that screen deliberately needs NO endpoint: the app states its own version
 * from a build-time constant. The asymmetry is the design — the page must still be able to say
 * which bundle you are running at the exact moment every request to this service is failing, which
 * is the situation the page exists for.
 */
@ApiTags('System')
@Controller('system')
export class SystemController {
  @Get('version')
  @UseGuards(SessionGuard)
  // ⚠️ NOT exempt from the forced-password-change gate, and I nearly made it exempt on the
  // reasoning that a version number is harmless. The exempt set is a CLOSED list of six routes,
  // documented as such, and guarded by an e2e lockout matrix — "this one is harmless" is how every
  // closed list stops being one. It is also unnecessary: the forced-reset screen is a full-screen
  // takeover that comes BEFORE the portal shell, so the version page is unreachable there anyway.
  @ApiCookieAuth('session')
  @ApiOperation({
    summary: 'The deployed build of this service.',
    description:
      'Behind the session guard on purpose — it is deliberately NOT on the public /health probe, ' +
      'because publishing an exact build to the open internet is how a scanner matches a CVE to a ' +
      'deployment. Every role gets the identical answer: the version screen shows the same thing ' +
      'to everyone and carries no per-user data.',
  })
  @ApiOkResponse({ description: 'Build metadata.', type: VersionResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'CSRF failure, or a password change is required.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  version(): VersionResponseDto {
    // Read from the environment at request time, not captured at module load: a container that is
    // restarted with a new stamp must report the new one without a code change. `unknown` and
    // `null` are honest answers — a deploy that forgot to stamp the build should say so, not
    // invent a plausible-looking commit.
    //
    // ⚠️ `npm_package_version` is the DEV fallback, and it is not a nicety. npm sets it from this
    // package's own `version` for anything launched with `npm run`, so a developer box reports the
    // code it is actually running without anyone maintaining a second copy of the number in a
    // `.env`. Without it every unstamped box answered `0.0.0`, and the version screen showed a
    // permanent amber "the server is behind" — which is how a warning colour stops being read by
    // the time a real mismatch appears. It is deliberately BELOW `APP_VERSION`: a container runs
    // `node dist/main`, npm sets nothing, and the deploy's stamp must always win.
    //
    // ⚠️ `stamp()` treats EMPTY as unset, and `??` cannot: `.env.example` documents these three by
    // listing them blank, so a copied `.env` sets each to `''` — which is a value, so `??` keeps
    // it and the endpoint answers `version: ""`. That is worse than the fallback it was meant to
    // avoid, and it appears only on a box configured exactly the way the docs say to.
    const stamp = (v: string | undefined) =>
      v && v.trim() ? v.trim() : undefined;
    return {
      version:
        stamp(process.env.APP_VERSION) ??
        stamp(process.env.npm_package_version) ??
        '0.0.0',
      build: stamp(process.env.APP_BUILD) ?? 'unknown',
      releasedAt: stamp(process.env.APP_RELEASED_AT) ?? null,
    };
  }
}
