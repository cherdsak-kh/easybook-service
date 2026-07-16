import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SystemRole } from '@prisma/client';
import { PasswordService } from '../auth/password.service';
import { normaliseEmail } from '../auth/login-throttle.key';
import { mapTransactionError } from '../common/prisma-tx.util';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateOwnProfileDto } from '../auth/dto/update-own-profile.dto';
import { CreateSystemUserDto } from './dto/create-system-user.dto';
import { ListSystemUsersQueryDto } from './dto/list-system-users-query.dto';
import { PaginatedSystemUsersResponseDto } from './dto/paginated-system-users-response.dto';
import { SystemUserResponseDto } from './dto/system-user-response.dto';
import { SystemUserWithTemporaryPasswordDto } from './dto/system-user-with-temporary-password.dto';
import { UpdateSystemUserDto } from './dto/update-system-user.dto';
import {
  EMAIL_TAKEN,
  INVALID_DEPARTMENT,
  INVALID_PERSONNEL_ROLE,
  LAST_SUPER_ADMIN,
  SYSTEM_USER_NOT_FOUND,
  USER_NOT_DELETED,
} from './system-users.errors';
import { PUBLIC_FIELDS, toSystemUserDto } from './system-users.fields';
import {
  Actor,
  canDelete,
  canPatch,
  canResetPassword,
} from './system-users.policy';

/**
 * The write half of the read/write asymmetry (AC-B3/AC-B4). Runs INSIDE the caller's transaction, so
 * an option cannot be soft-deleted between the check and the write.
 *
 * **The FK does NOT do this job.** `onDelete: Restrict` guards HARD deletes; a soft-deleted option
 * row still exists, so Postgres accepts the reference happily. Only this check rejects it. Do not
 * remove it on the theory that "the FK covers it".
 *
 * This is VALIDATION, not authorization — it stays in the service and does NOT go into
 * `system-users.policy.ts` (AC-B12 is about the authz matrix; the policy has no Prisma and no I/O
 * by design, so an existence check could not live there anyway).
 */
async function assertOptionsAreActive(
  tx: Prisma.TransactionClient,
  ids: { departmentId?: number; personnelRoleId?: number },
): Promise<void> {
  if (ids.departmentId !== undefined) {
    const ok = await tx.department.findFirst({
      where: { id: ids.departmentId, deletedAt: null },
      select: { id: true },
    });
    if (!ok) throw new BadRequestException(INVALID_DEPARTMENT);
  }
  if (ids.personnelRoleId !== undefined) {
    const ok = await tx.personnelRole.findFirst({
      where: { id: ids.personnelRoleId, deletedAt: null },
      select: { id: true },
    });
    if (!ok) throw new BadRequestException(INVALID_PERSONNEL_ROLE);
  }
}

/** `role = SUPER_ADMIN AND isActive = true AND deletedAt IS NULL`. */
const ACTIVE_SUPER_ADMIN: Prisma.SystemUserWhereInput = {
  role: SystemRole.SUPER_ADMIN,
  isActive: true,
  deletedAt: null,
};

/**
 * The last-active-`SUPER_ADMIN` invariant.
 *
 * The count runs **after** the write and **inside** the same transaction; throwing is what makes
 * Prisma issue `ROLLBACK`, so the `409` and the rollback are the same event. This is deliberately
 * not a pre-check: a read-then-write count is a TOCTOU bug — two SUPER_ADMINs demoting each other
 * concurrently both read "2", both pass, both commit, and the system is bricked. Under
 * READ COMMITTED a post-write count does not fix it either, since neither transaction sees the
 * other's uncommitted write. Only Serializable does.
 *
 * NOTE FOR WHOEVER READS THIS AND CALLS IT DEAD CODE — DO NOT DELETE IT. The self-mutation rules
 * in `system-users.policy.ts` make the single-threaded lockout unreachable (the only actor who
 * could remove the last active SUPER_ADMIN is that SUPER_ADMIN, and self-DELETE, self-`role` and
 * self-`isActive` are each a 403). The invariant exists for (i) the concurrent race above, which
 * is genuinely reachable, and (ii) defence in depth if those self-rules are ever relaxed. Because
 * it is unreachable end to end, it is verified at the service layer in the accompanying spec.
 */
async function assertActiveSuperAdminRemains(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const remaining = await tx.systemUser.count({ where: ACTIVE_SUPER_ADMIN });
  if (remaining === 0) throw new ConflictException(LAST_SUPER_ADMIN);
}

@Injectable()
export class SystemUsersService {
  private readonly logger = new Logger(SystemUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly password: PasswordService,
  ) {}

  /**
   * The only creation path besides the offline seed script.
   *
   * The SERVER issues the password (AC-B7): a temp password is generated, argon2id-hashed, and the
   * plaintext returned exactly ONCE in this response. `CreateSystemUserDto` has no `password` field,
   * so there is no second credential path that could bypass the forced-reset gate.
   *
   * Duplicate handling is write-then-catch, never read-then-write: two concurrent inserts of the
   * same email must yield one `201` and one `409`, which only the unique constraint can guarantee.
   * The `@unique` index spans soft-deleted rows, so a deleted user's email collides for free — and
   * the message stays generic so it never reveals that the colliding row is deleted.
   *
   * The transaction exists because the option validation must see the same snapshot as the write.
   */
  async create(
    actorId: string,
    dto: CreateSystemUserDto,
  ): Promise<SystemUserWithTemporaryPasswordDto> {
    const temporaryPassword = this.password.generateTemporaryPassword();
    const digest = await this.password.hash(temporaryPassword);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await assertOptionsAreActive(tx, {
          departmentId: dto.departmentId,
          personnelRoleId: dto.personnelRoleId,
        });

        return tx.systemUser.create({
          data: {
            email: normaliseEmail(dto.email), // defence in depth; the DTO already normalised it
            passwordHash: digest,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: dto.role,
            departmentId: dto.departmentId,
            personnelRoleId: dto.personnelRoleId,
            // Explicit, not relying on the DB default: this is the flag's whole point.
            mustChangePassword: true,
            phoneNumber: dto.phoneNumber ?? null,
            profilePictureUrl: dto.profilePictureUrl ?? null,
            createdById: actorId,
          },
          select: PUBLIC_FIELDS,
        });
      });

      // `id=`-only, exactly as before. NEVER log the DTO or the temp password (AC-B7).
      this.logger.log(`SystemUser created. id=${created.id} by=${actorId}`);
      return { ...toSystemUserDto(created), temporaryPassword };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(EMAIL_TAKEN);
      }
      throw error;
    }
  }

  /**
   * `POST /system-users/:id/reset-password` — issue a NEW temp password, returned once (AC-B7).
   *
   * Needs none of the heavier machinery, provably: the write cannot change `role`, `isActive` or
   * `deletedAt`, so it cannot decrease the active-SUPER_ADMIN count ⇒ no invariant check ⇒ no
   * `Serializable` ⇒ no `mapTransactionError`. Same shape of argument as `restore`.
   *
   * A SUSPENDED (`isActive: false`) target is a VALID target — the flags are orthogonal. Resetting
   * their password is allowed; they still cannot log in. Do not add an `isActive` filter.
   *
   * Accepted race (documented, not engineered around): two SUPER_ADMINs resetting the same target
   * concurrently both receive a syntactically valid temp password; only the last committed one works.
   * Both actors are SUPER_ADMINs, so this is a UX wrinkle, not a security defect.
   */
  async resetPassword(
    actor: Actor,
    id: string,
  ): Promise<SystemUserWithTemporaryPasswordDto> {
    const temporaryPassword = this.password.generateTemporaryPassword();
    const digest = await this.password.hash(temporaryPassword);

    const updated = await this.prisma.$transaction(async (tx) => {
      const target = await tx.systemUser.findFirst({
        where: { id, deletedAt: null }, // a soft-deleted id is byte-identical to an unknown one
        select: { id: true, role: true },
      });
      if (!target) throw new NotFoundException(SYSTEM_USER_NOT_FOUND);

      const verdict = canResetPassword(actor, target);
      if (!verdict.allowed) throw new ForbiddenException(verdict.reason);

      return tx.systemUser.update({
        where: { id: target.id },
        data: { passwordHash: digest, mustChangePassword: true },
        select: PUBLIC_FIELDS,
      });
    });

    this.logger.log(
      `SystemUser password reset. id=${updated.id} by=${actor.id}`,
    );
    return { ...toSystemUserDto(updated), temporaryPassword };
  }

  /**
   * `RepeatableRead`, not the default: under READ COMMITTED each statement takes a fresh snapshot,
   * so `meta.total` could genuinely disagree with `data`. A read-only RepeatableRead transaction
   * can never abort.
   */
  async findManyPaginated({
    page,
    limit,
  }: ListSystemUsersQueryDto): Promise<PaginatedSystemUsersResponseDto> {
    const where: Prisma.SystemUserWhereInput = { deletedAt: null }; // identity read → filter

    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.systemUser.findMany({
          where,
          select: PUBLIC_FIELDS,
          // The `id` tiebreak is MANDATORY — `createdAt` is not unique, and without it rows can
          // repeat or vanish across pages.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.systemUser.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      data: rows.map(toSystemUserDto),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** A soft-deleted id is indistinguishable from one that never existed. */
  async findOne(id: string): Promise<SystemUserResponseDto> {
    const row = await this.prisma.systemUser.findFirst({
      where: { id, deletedAt: null },
      select: PUBLIC_FIELDS,
    });
    if (!row) throw new NotFoundException(SYSTEM_USER_NOT_FOUND);
    return toSystemUserDto(row);
  }

  /**
   * Target load, policy, write and invariant, all inside ONE transaction (DD-8) — so the
   * authorization decision and the write see the same snapshot. A guard that fetched the target
   * would read it outside the write's transaction, leaving a window in which a concurrent
   * `STAFF → ADMIN` promotion lets an `ADMIN` patch an `ADMIN`.
   */
  async update(
    actor: Actor,
    id: string,
    patch: UpdateSystemUserDto,
  ): Promise<SystemUserResponseDto> {
    // DD-9 + DD-11. Only `role`, `isActive` and `deletedAt` writes can reduce the active
    // SUPER_ADMIN count, so a profile-only patch needs neither the invariant nor Serializable.
    // Running every update at Serializable would be actively harmful: the invariant's `count()`
    // predicate seq-scans `system_users`, so Postgres SSI escalates to a page/relation predicate
    // lock, and two operators editing two unrelated STAFF profiles would 409 each other.
    const touchesInvariant =
      patch.role !== undefined || patch.isActive !== undefined;

    const run = async (tx: Prisma.TransactionClient) => {
      const target = await tx.systemUser.findFirst({
        where: { id, deletedAt: null }, // step 4 — soft-deleted == absent
        select: { id: true, role: true },
      });
      if (!target) throw new NotFoundException(SYSTEM_USER_NOT_FOUND);

      const verdict = canPatch(actor, target, patch); // steps 5 + 6
      if (!verdict.allowed) throw new ForbiddenException(verdict.reason);

      // Inside the transaction, so an option cannot be soft-deleted between check and write.
      await assertOptionsAreActive(tx, {
        departmentId: patch.departmentId,
        personnelRoleId: patch.personnelRoleId,
      });

      const updated = await tx.systemUser.update({
        where: { id: target.id },
        // EXPLICIT, field by field. Never `data: { ...patch }` — a spread would silently make any
        // future DTO field writable. Prisma treats `undefined` as skip and `null` as set-null, so
        // the null semantics need no branching here. There is no code path in this method that
        // reads or writes the password digest.
        data: {
          firstName: patch.firstName,
          lastName: patch.lastName,
          departmentId: patch.departmentId,
          personnelRoleId: patch.personnelRoleId,
          phoneNumber: patch.phoneNumber,
          profilePictureUrl: patch.profilePictureUrl,
          role: patch.role,
          isActive: patch.isActive,
        },
        select: PUBLIC_FIELDS,
      });

      if (touchesInvariant) await assertActiveSuperAdminRemains(tx); // step 7
      return updated;
    };

    try {
      const updated = await this.prisma.$transaction(
        run,
        touchesInvariant
          ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
          : undefined,
      );
      return toSystemUserDto(updated);
    } catch (error) {
      mapTransactionError(error); // rethrows; P2034 / 40001 / 40P01 → 409, never 500
    }
  }

  /**
   * Soft delete. `update`, NEVER `delete`.
   *
   * A hard delete would cascade, orphan, or null the `createdById` audit chain — the very thing
   * the retained row exists to preserve. Prisma's hard-delete methods are called nowhere in this
   * codebase, and the physical row count of `system_users` is invariant under this method.
   *
   * Always `Serializable`: a delete always threatens the last-active-SUPER_ADMIN invariant.
   */
  async softDelete(actor: Actor, id: string): Promise<void> {
    const run = async (tx: Prisma.TransactionClient) => {
      const target = await tx.systemUser.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, role: true },
      });
      // Covers both a second DELETE on the same id and an id that never existed — byte-identical.
      if (!target) throw new NotFoundException(SYSTEM_USER_NOT_FOUND);

      const verdict = canDelete(actor, target);
      if (!verdict.allowed) throw new ForbiddenException(verdict.reason);

      await tx.systemUser.update({
        where: { id: target.id },
        data: { deletedAt: new Date() },
        select: { id: true },
      });

      await assertActiveSuperAdminRemains(tx);
    };

    try {
      await this.prisma.$transaction(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      this.logger.log(`SystemUser soft-deleted. id=${id} by=${actor.id}`);
    } catch (error) {
      mapTransactionError(error);
    }
  }

  /**
   * Clears `deletedAt` and nothing else. A user suspended before deletion comes back suspended —
   * `isActive` and `deletedAt` are orthogonal. Their role, profile and password are untouched, so
   * their original password still works.
   *
   * This is THE single sanctioned query in this service that omits the `deletedAt: null` filter
   * when resolving a target. It is SUPER_ADMIN-only, and disclosing "this id is soft-deleted" is
   * precisely this endpoint's purpose.
   *
   * Needs none of the machinery the other two writes need, provably:
   *   1. No invariant check — clearing `deletedAt` can only keep or *increase* the active
   *      SUPER_ADMIN count, and an operation that cannot decrease it cannot violate "must be ≥ 1".
   *   2. No unique-collision handling — `email` carries a plain `@unique` spanning deleted rows,
   *      so while the row sat deleted nobody could have taken its address. `P2002` is unreachable.
   *      Identically for `lineUserId`, the table's other unique column, which this does not write.
   *   3. No self-mutation rule — an authenticated actor necessarily has `deletedAt === null` and a
   *      restorable target necessarily has `deletedAt !== null`, so `actor.id === target.id` is
   *      unconstructible here.
   *
   * Two simultaneous restores of the same id may both observe `deletedAt != null` and both write
   * `null`. The end state is identical and correct; that is not worth a Serializable transaction.
   */
  async restore(id: string): Promise<SystemUserResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.systemUser.findUnique({
        where: { id },
        select: { id: true, deletedAt: true },
      });
      if (!target) throw new NotFoundException(SYSTEM_USER_NOT_FOUND);
      if (target.deletedAt === null)
        throw new ConflictException(USER_NOT_DELETED);

      const restored = await tx.systemUser.update({
        where: { id: target.id },
        data: { deletedAt: null }, // ONLY deletedAt. Not isActive, not role, not the digest.
        select: PUBLIC_FIELDS,
      });
      this.logger.log(`SystemUser restored. id=${restored.id}`);
      return toSystemUserDto(restored);
    });
  }

  /**
   * `PATCH /auth/system/me` — the caller edits their OWN profile (`SELF-PROFILE-1`).
   *
   * No policy call and no transaction, deliberately: the allowlist is `UpdateOwnProfileDto`'s field
   * set (enforced by `forbidNonWhitelisted` at the pipe), there is no target but self, and no field
   * here bears an invariant. A single-row update with no cross-row read needs no ceremony.
   *
   * Field by field, never `{...dto}` — same discipline as `update()`.
   */
  async updateOwnProfile(
    id: string,
    patch: UpdateOwnProfileDto,
  ): Promise<SystemUserResponseDto> {
    const updated = await this.prisma.systemUser.update({
      where: { id },
      data: {
        firstName: patch.firstName,
        lastName: patch.lastName,
        phoneNumber: patch.phoneNumber,
        profilePictureUrl: patch.profilePictureUrl,
      },
      select: PUBLIC_FIELDS,
    });
    return toSystemUserDto(updated);
  }

  /** The `profilePictureUrl` write behind `POST /auth/system/me/avatar`. */
  async setOwnAvatar(id: string, url: string): Promise<SystemUserResponseDto> {
    const updated = await this.prisma.systemUser.update({
      where: { id },
      data: { profilePictureUrl: url },
      select: PUBLIC_FIELDS,
    });
    return toSystemUserDto(updated);
  }
}
