import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
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
import { RevokeSessionsResponseDto } from '../auth/sessions/dto/session.dto';
import { StaffSessionSummaryDto } from '../auth/sessions/dto/staff-session-summary.dto';
import { StaffSessionsService } from '../auth/sessions/staff-sessions.service';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateSystemUserDto } from './dto/create-system-user.dto';
import { ListSystemUsersQueryDto } from './dto/list-system-users-query.dto';
import { PaginatedSystemUsersResponseDto } from './dto/paginated-system-users-response.dto';
import { SystemUserResponseDto } from './dto/system-user-response.dto';
import { SystemUserWithTemporaryPasswordDto } from './dto/system-user-with-temporary-password.dto';
import { UpdateSystemUserDto } from './dto/update-system-user.dto';
import { SystemUsersService } from './system-users.service';
import type { Actor } from './system-users.policy';

const actorOf = (user: AuthenticatedSystemUser): Actor => ({
  id: user.id,
  role: user.role,
  // `createdBy` is the resolved object; the policy wants the id. It is selected WITHOUT any filter
  // (DD-4), so a soft-deleted creator still resolves and STAFF-CREATOR-1 still fires for them.
  createdById: user.createdBy?.id ?? null,
});

/**
 * Back-office user management. Route prefix: `/api/v1/system-users`.
 *
 * `@Roles(...)` is the **coarse** gate. Target-dependent authorization ("an ADMIN may only patch
 * a VIEWER", the three self-mutation rules) lives in `system-users.policy.ts` and runs inside the
 * service's write transaction. Guards run before pipes, so a VIEWER caller sending a malformed body
 * gets `403`, not `400` — that ordering is correct: authorization must never be decided after a
 * validation error has already told the caller something about the schema.
 *
 * `:id` is an opaque, unvalidated string on purpose (DD-14). A format check would turn a malformed
 * id into `400` while an absent id stayed `404`, creating a shape oracle.
 */
@ApiTags('System Users')
@ApiCookieAuth('session')
@Controller('system-users')
@UseGuards(SessionGuard, RolesGuard)
export class SystemUsersController {
  constructor(
    private readonly systemUsers: SystemUsersService,
    private readonly staffSessions: StaffSessionsService,
  ) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Create a back-office user.',
    description:
      'The only creation path besides the offline seed script. There is no public registration. The SERVER issues a temporary password and returns it EXACTLY ONCE as `temporaryPassword` — it is argon2id-hashed at rest, never logged, and never retrievable again; deliver it out-of-band. `password` and `lineUserId` are not accepted — any extra key is a 400. `departmentId`/`personnelRoleId` must reference ACTIVE options.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiCreatedResponse({
    description: 'Created. Carries the one-time `temporaryPassword`.',
    type: SystemUserWithTemporaryPasswordDto,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or departmentId/personnelRoleId is unknown or soft-deleted.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'Not a SUPER_ADMIN, CSRF failure, or a password change is required.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'That email is already taken (including by a soft-deleted user).',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  create(
    @CurrentUser() actor: AuthenticatedSystemUser,
    @Body() dto: CreateSystemUserDto,
  ): Promise<SystemUserWithTemporaryPasswordDto> {
    return this.systemUsers.create(actorOf(actor), dto);
  }

  /*
   * ⚠️ VIEWER READS, AND THAT RETIRES HALF OF AC-45 (PO, 19 ส.ค. 2569).
   *
   * AC-45 read "VIEWER gets 403 on every /system-users route". The prototype's own role table for
   * เจ้าหน้าที่ระบบ says the opposite for the two READ routes — เห็นรายชื่อ + รายละเอียด is ✅ for all
   * three roles — and `use-acl.ts` in the app keeps that destination out of `VIEWER_DENY` on purpose
   * ("a supervisor may see who holds an account"). With the guard as it was, that page answered 403
   * for the one role it was designed to be readable by.
   *
   * The WRITE half of AC-45 is untouched and still tested: create, delete, restore and
   * reset-password stay SUPER_ADMIN, PATCH stays SUPER_ADMIN|ADMIN, and `system-users.policy.ts`
   * still decides per target inside the transaction.
   *
   * ⚠️ `status=deleted` DOES NOT WIDEN WITH THIS. It is gated separately in the service by
   * `actorRole !== SUPER_ADMIN` (`findManyPaginated`), because `RolesGuard` runs before the pipe and
   * cannot see the query — so a VIEWER asking for deleted rows is still a 403.
   *
   * ⚠️ WHAT IT COSTS: `GET /system-users/:id` no longer hides existence from a VIEWER — a real id
   * answers 200 where an invented one answers 404. That is inherent in letting them read the
   * directory, and the directory is the thing that lists those ids anyway.
   */
  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'List back-office users, paginated.',
    description:
      'Search matches the first name, last name, email or phone number, case-insensitively. The phone match is on the number as stored and is therefore format-sensitive (`0812345678` does not match a stored `081-234-5678`). `role` and `status` narrow further; `status` is derived (`deleted` > `suspended` > `pending` > `active`), matching the badge the screen shows. Soft-deleted rows are excluded from `data` and from `meta.total` unless `status=deleted`, which is SUPER_ADMIN-only and is the only way to obtain the id a restore needs. Ordered `createdAt DESC, id DESC`. A page beyond the last one is a 200 with an empty `data`, not a 404.',
  })
  @ApiOkResponse({
    description: 'A page of users.',
    type: PaginatedSystemUsersResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      '`status=deleted` asked by a non-SUPER_ADMIN. Every role may read the collection itself.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @CurrentUser() actor: AuthenticatedSystemUser,
    @Query() query: ListSystemUsersQueryDto,
  ): Promise<PaginatedSystemUsersResponseDto> {
    // The role reaches the service because `status=deleted` is SUPER_ADMIN-only and `RolesGuard`
    // runs before the pipe — it cannot see the query it would need to judge.
    return this.systemUsers.findManyPaginated(query, actor.role);
  }

  @Get(':id')
  // Same widening as the collection above — see the note there.
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.VIEWER)
  @ApiOperation({
    summary: 'Read one back-office user.',
    description:
      'A soft-deleted id returns a 404 byte-identical to an id that never existed.',
  })
  @ApiOkResponse({ description: 'The user.', type: SystemUserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'VIEWER has no access to this collection.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  findOne(@Param('id') id: string): Promise<SystemUserResponseDto> {
    return this.systemUsers.findOne(id);
  }

  @Patch(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'Update a back-office user.',
    description:
      'Never the password and never the email. `role` is SUPER_ADMIN-write-only and is rejected on key presence, so an ADMIN sending any valid role value gets 403. Nobody may change their own `role` or `isActive`. An ADMIN may patch their OWN row (department, position and profile fields); their own `role` and `isActive` remain 403, as for everyone, and a different ADMIN or a SUPER_ADMIN is still 403. An unknown OR system-reserved `departmentId`/`personnelRoleId` is the same 400 in both cases — never a 403. An empty body is a 400.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Updated.', type: SystemUserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'VIEWER; CSRF failure; a self-mutation rule; or a policy denial.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'Would remove the last active SUPER_ADMIN, or lost a concurrent-write race.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  update(
    @CurrentUser() actor: AuthenticatedSystemUser,
    @Param('id') id: string,
    @Body() dto: UpdateSystemUserDto,
  ): Promise<SystemUserResponseDto> {
    return this.systemUsers.update(actorOf(actor), id, dto);
  }

  // @HttpCode(204) is MANDATORY — Nest defaults DELETE to 200. The body must be empty: a
  // tombstone body would leak the deletion timestamp.
  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Soft-delete a back-office user.',
    description:
      'Marks the user as removed; never a hard delete, so the `createdById` audit chain stays resolvable. A second DELETE on the same id is a 404, identical to an id that never existed. Nobody may delete their own account. The email stays permanently burned — restore the row instead of re-creating it.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiNoContentResponse({ description: 'Soft-deleted. Empty body.' })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'Not a SUPER_ADMIN; CSRF failure; or deleting your own account.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or already-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'Would remove the last active SUPER_ADMIN, or lost a concurrent-write race.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  remove(
    @CurrentUser() actor: AuthenticatedSystemUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.systemUsers.softDelete(actorOf(actor), id);
  }

  // @HttpCode(200) is MANDATORY — Nest defaults POST to 201, and this creates nothing.
  @Post(':id/restore')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Restore a soft-deleted back-office user.',
    description:
      'Un-deletes the row and changes nothing else. A user suspended before deletion comes back suspended; their original password still works. Their `id`, `createdById`, `createdAt`, `role` and `isActive` are unchanged.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Restored.', type: SystemUserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Not a SUPER_ADMIN, or CSRF failure.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Unknown id.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'The row is not deleted.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  restore(@Param('id') id: string): Promise<SystemUserResponseDto> {
    return this.systemUsers.restore(id);
  }

  // Declared adjacent to `:id/restore` — the only other 3-segment POST, and a different literal in
  // the same position, so the two cannot collide. @HttpCode(200) is MANDATORY: Nest defaults POST to
  // 201 and this creates nothing.
  @Post(':id/reset-password')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Issue a new temporary password for a user.',
    description:
      'Generates a new temporary password, stores only its argon2id digest, and sets `mustChangePassword` — confining the target to the password-change screen until they set their own. The plaintext is returned EXACTLY ONCE as `temporaryPassword`; deliver it out-of-band. You cannot reset your OWN password (use POST /auth/system/password). A SUSPENDED user is a valid target — the flags are orthogonal — though they still cannot log in.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({
    description: 'Reset. Carries the one-time `temporaryPassword`.',
    type: SystemUserWithTemporaryPasswordDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'Not a SUPER_ADMIN; CSRF failure; resetting your own password; or a password change is required.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  resetPassword(
    @CurrentUser() actor: AuthenticatedSystemUser,
    @Param('id') id: string,
  ): Promise<SystemUserWithTemporaryPasswordDto> {
    return this.systemUsers.resetPassword(actorOf(actor), id);
  }

  // LOGIN-SESSIONS-1. `GET :id/sessions` (3 segments) cannot collide with `GET :id` (2), and these are
  // distinct third-segment literals beside `:id/restore` / `:id/reset-password`.
  @Get(':id/sessions')
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: "A user's live-session count and last sign-in (SUPER_ADMIN).",
    description:
      'Returns the number of live sessions (always 0 for a suspended account, which makes no Redis call), the last successful sign-in (device · time · IP, from the 90-day login history, falling back to `lastLoginAt` alone) and the time of the latest forced sign-out. The actor of a forced sign-out is never returned. Reading your own row is allowed. A soft-deleted id is a 404 identical to one that never existed.',
  })
  @ApiOkResponse({
    description: 'The session summary.',
    type: StaffSessionSummaryDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Not a SUPER_ADMIN, or a password change is required.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  sessionSummary(@Param('id') id: string): Promise<StaffSessionSummaryDto> {
    return this.staffSessions.summary(id);
  }

  // @HttpCode(200) is MANDATORY — Nest defaults POST to 201 and this creates nothing.
  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @Roles(SystemRole.SUPER_ADMIN)
  @ApiOperation({
    summary: "Force sign-out of every one of a user's devices (SUPER_ADMIN).",
    description:
      "Ends EVERY live session of the target, including the one it is using now. It is NOT a suspension: `isActive` is untouched and the target can sign in again with the same password. Idempotent: with no live session it is a 200 with `revoked: 0` and writes nothing. When at least one session was ended, exactly one FORCE_REVOKED row is written to the target's login history (the actor is stored, never exposed to the target). You cannot force sign-out your own account (400): use `DELETE /auth/system/sessions/others`. A SUPER_ADMIN may force a peer SUPER_ADMIN, or their own creator. A suspended target is a valid target.",
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({
    description: 'How many live sessions were ended.',
    type: RevokeSessionsResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'The target is the caller.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'Not a SUPER_ADMIN; CSRF failure; or a password change is required.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Unknown or soft-deleted id.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable. Nothing was revoked.',
    type: ErrorResponseDto,
  })
  revokeSessions(
    @CurrentUser() actor: AuthenticatedSystemUser,
    @Param('id') id: string,
  ): Promise<RevokeSessionsResponseDto> {
    return this.staffSessions.forceRevoke(actorOf(actor), id);
  }
}
