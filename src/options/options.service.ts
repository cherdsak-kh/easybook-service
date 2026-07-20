import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
}

/** A `Department`/`PersonnelRole` row narrowed to the public select. Dates are still `Date`s. */
interface OptionRow {
  id: number;
  name: string;
  isSystemReserved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

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
    };
    orderBy: { name: 'asc' };
  }): Promise<OptionRow[]>;
  findFirst(args: {
    where: { id: number; deletedAt: null; isSystemReserved?: boolean };
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
} as const;

const toDto = (row: OptionRow): OptionResponse => ({
  id: row.id,
  name: row.name,
  isSystemReserved: row.isSystemReserved,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
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

    await this.delegate(model).update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
      select: PUBLIC_SELECT,
    });
    this.logger.log(`Option soft-deleted. model=${model} id=${id}`);
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
