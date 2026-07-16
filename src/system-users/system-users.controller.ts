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
});

/**
 * Back-office user management. Route prefix: `/api/v1/system-users`.
 *
 * `@Roles(...)` is the **coarse** gate. Target-dependent authorization ("an ADMIN may only patch
 * a STAFF", the three self-mutation rules) lives in `system-users.policy.ts` and runs inside the
 * service's write transaction. Guards run before pipes, so a STAFF caller sending a malformed body
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
  constructor(private readonly systemUsers: SystemUsersService) {}

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
    return this.systemUsers.create(actor.id, dto);
  }

  @Get()
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
  @ApiOperation({
    summary: 'List back-office users, paginated.',
    description:
      'Soft-deleted rows are excluded from `data` and from `meta.total`. Ordered `createdAt DESC, id DESC`. A page beyond the last one is a 200 with an empty `data`, not a 404.',
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
    description: 'STAFF has no access to this collection.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'Session store unavailable.',
    type: ErrorResponseDto,
  })
  list(
    @Query() query: ListSystemUsersQueryDto,
  ): Promise<PaginatedSystemUsersResponseDto> {
    return this.systemUsers.findManyPaginated(query);
  }

  @Get(':id')
  @Roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
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
    description: 'STAFF has no access to this collection.',
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
      'Never the password and never the email. `role` is SUPER_ADMIN-write-only and is rejected on key presence, so an ADMIN sending any valid role value gets 403. Nobody may change their own `role` or `isActive`. An empty body is a 400.',
  })
  @ApiHeader({ name: 'x-csrf-token', required: true })
  @ApiOkResponse({ description: 'Updated.', type: SystemUserResponseDto })
  @ApiUnauthorizedResponse({
    description: 'No session.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'STAFF; CSRF failure; a self-mutation rule; or a policy denial.',
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
}
