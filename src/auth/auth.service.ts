import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import {
  INVALID_CREDENTIALS,
  INVALID_CURRENT_PASSWORD,
  PASSWORD_UNCHANGED,
} from './auth.constants';
import { LoginResponseDto } from './dto/login-response.dto';
import { loginIpEmailKey, normaliseEmail } from './login-throttle.key';
import { PasswordService } from './password.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Resolves a login, or throws a uniform `401`.
   *
   * The three rejection reasons — no such account, soft-deleted, suspended — share **one branch,
   * one argon2 cost, and one response**. An early return for any of them would answer measurably
   * faster than an active account with a wrong password, which is an account-existence *and*
   * account-state oracle.
   *
   * The lookup deliberately does not filter `deletedAt: null`. Filtering would also produce a
   * uniform response, but it would collapse "deleted" into "not found" before the state is known,
   * making the timing guarantee an accident of query planning rather than a reviewable property.
   */
  async validateCredentials(
    email: string,
    password: string,
    ip: string,
  ): Promise<LoginResponseDto> {
    const normalised = normaliseEmail(email);

    const user = await this.prisma.systemUser.findUnique({
      where: { email: normalised },
    });

    if (!user || user.deletedAt !== null || !user.isActive) {
      await this.password.verify(await this.password.dummyHash(), password);
      this.logFailure(normalised, ip);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!(await this.password.verify(user.passwordHash, password))) {
      this.logFailure(normalised, ip);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    };
  }

  /** AC-9 — stamp the successful login. */
  async touchLastLogin(id: string): Promise<void> {
    await this.prisma.systemUser.update({
      where: { id },
      data: { lastLoginAt: new Date() },
      select: { id: true },
    });
  }

  /**
   * AC-21 — a successful login clears that email's failure counter.
   *
   * The per-IP counter is deliberately **not** cleared: a successful login must not reset a
   * password spray already in progress (AC-20).
   */
  async clearLoginThrottle(ip: string, email: string): Promise<void> {
    try {
      await this.redis.del(loginIpEmailKey(ip, normaliseEmail(email)));
    } catch (error) {
      // The session is already saved; failing to clear a counter is not worth failing the login.
      this.logger.warn(
        `Could not clear the login throttle counter: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * `POST /auth/system/password` — the forced AND voluntary password change. The ONE code path that
   * writes a password digest for an authenticated user.
   *
   * `SessionGuard` has already re-read the user and enforced `deletedAt`/`isActive` (both 401s), so
   * by here the caller is a live, valid account. The digest is re-read separately because it is
   * deliberately NOT in `PUBLIC_FIELDS`.
   *
   * Clearing `mustChangePassword` needs no session machinery: `SessionGuard`'s per-request DB re-read
   * means it takes effect on the caller's very NEXT request, automatically (AC-B9). The session is
   * deliberately NOT destroyed — no session-revocation machinery exists, or may be added.
   *
   * No rate limit, considered and rejected: the only throttled route is `login`, via a bespoke guard,
   * and there is no `APP_GUARD` — a limiter here means new machinery. The threat it would blunt (a
   * session hijacker brute-forcing `currentPassword`) requires the attacker to ALREADY hold a valid
   * session, and argon2id at m=19456,t=2 is itself ~50-100ms per attempt.
   */
  async changeOwnPassword(
    id: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.systemUser.findUnique({
      where: { id },
      select: { id: true, passwordHash: true },
    });
    // Unreachable: SessionGuard just re-read this row. Defence in depth against a concurrent purge.
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    // A 400, NOT a 401: the session is valid, only the re-auth failed. A 401 here is the SPA's
    // "session dead → bounce to login" signal and would log the user out for a typo.
    if (!(await this.password.verify(user.passwordHash, currentPassword))) {
      this.logger.warn(`Failed password change (wrong current). id=${id}`);
      throw new BadRequestException(INVALID_CURRENT_PASSWORD);
    }

    if (currentPassword === newPassword) {
      throw new BadRequestException(PASSWORD_UNCHANGED);
    }

    await this.prisma.systemUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.password.hash(newPassword),
        mustChangePassword: false, // the gate opens on the NEXT request, via the DB re-read
      },
      select: { id: true },
    });
    // id only — never the password, never the DTO.
    this.logger.log(`Password changed. id=${id}`);
  }

  /** Logs the email and source IP. Never the password, never the rejection reason. */
  private logFailure(email: string, ip: string): void {
    this.logger.warn(`Failed login attempt. email=${email} ip=${ip}`);
  }
}
