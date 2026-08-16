import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  TOMBSTONE_DEPARTMENT_NAME,
  TOMBSTONE_PERSONNEL_ROLE_NAME,
  TOMBSTONE_ROW_MISSING,
} from './options.constants';
import { OPTION_NAME_TAKEN, OPTION_NOT_FOUND } from './options.errors';

/** Which option table a call targets. Keeps ONE service serving both identical tables. */
export type OptionModel = 'department' | 'personnelRole';

/** The wire shape both `DepartmentResponseDto` and `PersonnelRoleResponseDto` satisfy structurally. */
export interface OptionResponse {
  id: number;
  name: string;
  isSystemReserved: boolean;
  createdAt: string;
  updatedAt: string;
  /** How many VISIBLE people hold this option — see `HOLDER_COUNT` for what "visible" excludes. */
  holderCount: number;
}

/** A `Department`/`PersonnelRole` row narrowed to the public select. Dates are still `Date`s. */
interface OptionRow {
  id: number;
  name: string;
  isSystemReserved: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count?: { systemUsers: number; registrations: number };
}

/**
 * The holder count the options screen shows, and the number its delete dialog states before it
 * states the verb (OPT-COUNT-1). BOTH populations are counted: these two tables are shared between
 * back-office staff and LINE registrations, so counting one would understate the blast radius of a
 * delete by exactly the other.
 *
 * ⚠️ SOFT-DELETED HOLDERS ARE EXCLUDED FROM THE COUNT AND STILL RE-POINTED BY THE DELETE. The
 * number answers "how many people will an operator SEE move", which is what a confirmation dialog
 * is for; the re-point has to touch every referencing row regardless, because the FK is required
 * and does not care whether a row is visible.
 */
const HOLDER_COUNT = {
  select: {
    systemUsers: { where: { deletedAt: null } },
    registrations: { where: { deletedAt: null } },
  },
} as const;

/**
 * The minimal slice of a Prisma model delegate this service uses. `Department` and `PersonnelRole`
 * have byte-identical delegates, but a union of their (heavily overloaded) Prisma types is not
 * callable in TS, so each accessor casts to this hand-written interface — the single, contained
 * escape hatch that lets one service serve both tables.
 */
interface OptionDelegate {
  findMany(args: {
    where: { deletedAt: null; isSystemReserved?: boolean };
    select: {
      id: true;
      name: true;
      isSystemReserved: true;
      createdAt: true;
      updatedAt: true;
      _count: typeof HOLDER_COUNT;
    };
    orderBy: { name: 'asc' };
  }): Promise<OptionRow[]>;
  findFirst(args: {
    where: {
      id?: number;
      name?: string;
      deletedAt: null;
      isSystemReserved?: boolean;
    };
    select: { id: true };
  }): Promise<{ id: number } | null>;
  create(args: {
    data: { name: string };
    select: {
      id: true;
      name: true;
      isSystemReserved: true;
      createdAt: true;
      updatedAt: true;
      _count: typeof HOLDER_COUNT;
    };
  }): Promise<OptionRow>;
  update(args: {
    where: { id: number };
    data: { name?: string; deletedAt?: Date };
    select: {
      id: true;
      name: true;
      isSystemReserved: true;
      createdAt: true;
      updatedAt: true;
      _count: typeof HOLDER_COUNT;
    };
  }): Promise<OptionRow>;
}

// `isSystemReserved` is exposed READ-ONLY (design §2): it is present on every option response, but
// on NO Create/Update DTO. Non-SUPER_ADMIN callers never receive a reserved row (the `includeReserved`
// WHERE clause), so they only ever see `false` — the flag carries no information for them and needs no
// role logic in this layer. `scripts/create-super-admin.ts` remains the sole writer of `true`.
const PUBLIC_SELECT = {
  id: true,
  name: true,
  isSystemReserved: true,
  createdAt: true,
  updatedAt: true,
  _count: HOLDER_COUNT,
} as const;

const toDto = (row: OptionRow): OptionResponse => ({
  id: row.id,
  name: row.name,
  isSystemReserved: row.isSystemReserved,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  // A freshly created option has no holders, and `?? 0` says so rather than letting an absent
  // aggregate surface as `undefined` in a field the screen prints.
  holderCount:
    (row._count?.systemUsers ?? 0) + (row._count?.registrations ?? 0),
});

/**
 * Admin CRUD for the two registration option tables (`Department`, `PersonnelRole`). Soft-delete
 * only — a `DELETE` sets `deletedAt`, never a hard delete (matches the `SystemUser` discipline),
 * so registrations referencing the option keep resolving its name.
 *
 * Uniqueness is the partial index `WHERE deletedAt IS NULL`: at most one ACTIVE row per name, and a
 * soft-deleted name is reusable. A create/rename that collides with an active name → `409`.
 */
@Injectable()
export class OptionsService {
  private readonly logger = new Logger(OptionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private delegate(model: OptionModel): OptionDelegate {
    return model === 'department'
      ? this.prisma.department
      : this.prisma.personnelRole;
  }

  /**
   * Non-deleted options, `name ASC` (stable).
   *
   * `includeReserved` is REQUIRED and deliberately non-defaulted: a `= false` default would be
   * safe-by-default but would let a new call site forget the decision exists. A required parameter
   * makes the compiler force every present and future caller to state its intent.
   *
   * It is a BOOLEAN, never a role. The role -> capability decision is
   * `mayUseSystemReservedOptions(actor)` in `system-users.policy.ts`, called by the controller: this
   * module must not mix option data with RBAC (AC-X3 fails the build if a `SystemRole` token appears
   * in option logic here).
   *
   * The filter is a WHERE clause, not a post-fetch drop, on purpose: the controller must never hold a
   * row it is not allowed to return. Filtering after the read would be one `console.log`, one future
   * `find()`, one debug-endpoint reuse away from a leak.
   */
  async list(
    model: OptionModel,
    opts: { includeReserved: boolean },
  ): Promise<OptionResponse[]> {
    const rows = await this.delegate(model).findMany({
      where: opts.includeReserved
        ? { deletedAt: null }
        : { deletedAt: null, isSystemReserved: false },
      select: PUBLIC_SELECT,
      orderBy: { name: 'asc' },
    });
    return rows.map(toDto);
  }

  /**
   * Create an option. Write-then-catch on the partial-unique index: an active-name collision is a
   * `409`; a name matching only soft-deleted rows succeeds.
   */
  async create(model: OptionModel, name: string): Promise<OptionResponse> {
    try {
      const created = await this.delegate(model).create({
        data: { name },
        select: PUBLIC_SELECT,
      });
      this.logger.log(`Option created. model=${model} id=${created.id}`);
      return toDto(created);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /**
   * Rename an option. `404` on unknown/soft-deleted id; `409` on an active-name collision.
   *
   * A SYSTEM-RESERVED target is also a `404` — for EVERY role, SUPER_ADMIN included. Reserved rows
   * are simply not CRUD-managed; `scripts/create-super-admin.ts` is their only writer. Renaming one
   * must fail regardless of actor because that script resolves them BY NAME, so a rename would make
   * the next run create a SECOND reserved row. Immutability is the correct semantic, not a limitation.
   * For an ADMIN the uniform 404 is additionally mandatory: a distinct 403 would be an existence
   * oracle, and reserved must be indistinguishable from never-existed.
   */
  async update(
    model: OptionModel,
    id: number,
    name: string,
  ): Promise<OptionResponse> {
    const existing = await this.delegate(model).findFirst({
      where: { id, deletedAt: null, isSystemReserved: false },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(OPTION_NOT_FOUND);

    try {
      const updated = await this.delegate(model).update({
        where: { id: existing.id },
        data: { name },
        select: PUBLIC_SELECT,
      });
      this.logger.log(`Option renamed. model=${model} id=${updated.id}`);
      return toDto(updated);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /**
   * Soft-delete an option (`update` setting `deletedAt`, NEVER a hard delete). A second delete on
   * the same id is a `404`, byte-identical to an unknown id (the read filters `deletedAt: null`).
   *
   * A SYSTEM-RESERVED target is likewise a `404` for every role, SUPER_ADMIN included (see `update`):
   * nothing re-creates a deleted reserved row, and it would vanish from the SUPER_ADMIN's own
   * dropdown. Its permanently-active name is also what makes an ordinary row of the same name a 409.
   */
  async softDelete(model: OptionModel, id: number): Promise<void> {
    const existing = await this.delegate(model).findFirst({
      where: { id, deletedAt: null, isSystemReserved: false },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(OPTION_NOT_FOUND);

    // MOVE, then delete — inside ONE transaction (OPT-FALLBACK-1).
    //
    // `departmentId` / `personnelRoleId` are REQUIRED FKs on both holder tables, so "the option
    // they held is gone" is not a state the database can represent: there is no null to move them
    // to. Without this, every holder keeps rendering the deleted option's name forever, and the
    // options screen reports 0 holders while another screen still prints that name on twelve rows.
    //
    // Order is load-bearing. Deleting first would leave a window where rows reference a
    // soft-deleted option, and the two statements are in one transaction so a failure between them
    // cannot leave that state behind permanently.
    //
    // BOTH populations move. These tables are shared between back-office staff and LINE
    // registrations; moving one and not the other is the same bug, half done.
    //
    // ⚠️ It re-points SOFT-DELETED holders too — deliberately, and unlike the holder COUNT, which
    // shows only visible people. The FK is required whether or not a row is visible, so a
    // soft-deleted user left pointing at a deleted option would break on restore.
    const fallbackId = await this.resolveTombstoneId(model);

    await this.prisma.$transaction(async (tx) => {
      const key =
        model === 'department'
          ? ('departmentId' as const)
          : ('personnelRoleId' as const);

      const [staff, registrations] = await Promise.all([
        tx.systemUser.updateMany({
          where: { [key]: existing.id },
          data: { [key]: fallbackId },
        }),
        tx.lineUserRegistration.updateMany({
          where: { [key]: existing.id },
          data: { [key]: fallbackId },
        }),
      ]);

      // Spelled out per branch rather than through a shared variable — a union of the two
      // (heavily overloaded) Prisma delegates is not callable in TypeScript, which is the same
      // fact `OptionDelegate` exists to work around at the class level.
      const data = { deletedAt: new Date() };
      if (model === 'department') {
        await tx.department.update({ where: { id: existing.id }, data });
      } else {
        await tx.personnelRole.update({ where: { id: existing.id }, data });
      }

      this.logger.log(
        `Option soft-deleted. model=${model} id=${id} ` +
          `movedStaff=${staff.count} movedRegistrations=${registrations.count}`,
      );
    });
  }

  /**
   * The row a deleted option's holders are moved to. Resolved by name, ACTIVE and RESERVED — the
   * same probe shape `create-super-admin.ts` uses to create it.
   *
   * A missing row is a 500 and not a silent skip: it means the database was migrated but never
   * seeded, the caller did nothing wrong, and deleting anyway would leave live rows pointing at a
   * soft-deleted option with no record of which ones they were.
   */
  private async resolveTombstoneId(model: OptionModel): Promise<number> {
    const name =
      model === 'department'
        ? TOMBSTONE_DEPARTMENT_NAME
        : TOMBSTONE_PERSONNEL_ROLE_NAME;

    const row = await this.delegate(model).findFirst({
      where: { name, deletedAt: null, isSystemReserved: true },
      select: { id: true },
    });
    if (!row) throw new InternalServerErrorException(TOMBSTONE_ROW_MISSING);
    return row.id;
  }

  /** A `P2002` from the partial-unique index → `409`; anything else is rethrown unchanged. */
  private mapWriteError(error: unknown): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(OPTION_NAME_TAKEN);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
