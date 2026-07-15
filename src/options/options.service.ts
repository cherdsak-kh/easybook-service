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
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** A `Department`/`PersonnelRole` row narrowed to the public select. Dates are still `Date`s. */
interface OptionRow {
  id: string;
  name: string;
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
    where: { deletedAt: null };
    select: { id: true; name: true; createdAt: true; updatedAt: true };
    orderBy: { name: 'asc' };
  }): Promise<OptionRow[]>;
  findFirst(args: {
    where: { id: string; deletedAt: null };
    select: { id: true };
  }): Promise<{ id: string } | null>;
  create(args: {
    data: { name: string };
    select: { id: true; name: true; createdAt: true; updatedAt: true };
  }): Promise<OptionRow>;
  update(args: {
    where: { id: string };
    data: { name?: string; deletedAt?: Date };
    select: { id: true; name: true; createdAt: true; updatedAt: true };
  }): Promise<OptionRow>;
}

const PUBLIC_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

const toDto = (row: OptionRow): OptionResponse => ({
  id: row.id,
  name: row.name,
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

  /** Non-deleted options, `name ASC` (stable). */
  async list(model: OptionModel): Promise<OptionResponse[]> {
    const rows = await this.delegate(model).findMany({
      where: { deletedAt: null },
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

  /** Rename an option. `404` on unknown/soft-deleted id; `409` on an active-name collision. */
  async update(
    model: OptionModel,
    id: string,
    name: string,
  ): Promise<OptionResponse> {
    const existing = await this.delegate(model).findFirst({
      where: { id, deletedAt: null },
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
   */
  async softDelete(model: OptionModel, id: string): Promise<void> {
    const existing = await this.delegate(model).findFirst({
      where: { id, deletedAt: null },
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
