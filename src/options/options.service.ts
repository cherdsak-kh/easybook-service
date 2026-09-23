import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OPTION_CACHE_KEYS, optionListKey } from '../redis/cache-keys';
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
  /**
   * The same total, SPLIT into the two populations it was summed from (OPT-COUNT-2, 18 ส.ค. 2569).
   *
   * The aggregate was always two numbers internally; only `toDto` merged them. The screens need
   * both halves: the edit dialog states "มีผู้ถือตำแหน่งนี้ 13 คน — ผู้ใช้ LINE 8 คน · เจ้าหน้าที่
   * ระบบ 5 คน", and the delete confirmation repeats the split before it names the verb. One merged
   * number hides WHICH population a delete is about to move, and those are different problems for
   * whoever has to clean up after it.
   *
   * `holderCount` stays and is still the sum — the table column shows the total. Additive, so no
   * existing consumer changes.
   */
  staffCount: number;
  registrationCount: number;
  /**
   * TRUE only for the tombstone row (`ไม่พบตำแหน่ง` / `ไม่พบกลุ่ม/ฝ่าย`) — where holders are
   * re-pointed when their option is deleted (OPT-FALLBACK-1).
   *
   * ⚠️ IT IS NOT DERIVABLE FROM `isSystemReserved`, which is what forced this field. Both the
   * System Developer row and the tombstone carry `isSystemReserved: true`, and the two need
   * OPPOSITE treatment in a picker: the reserved row may be assigned by a SUPER_ADMIN, while the
   * tombstone must never be offered — filing somebody under "not found" on purpose is not a choice
   * any form may present. Without this flag a client can only tell them apart by NAME, which puts
   * the tombstone's Thai spelling in two repositories and makes renaming it in one a silent
   * behaviour change in the other.
   *
   * Computed here by comparing against the constants this service already resolves tombstones by
   * (`resolveTombstoneId`), so there is exactly one place that knows the name.
   */
  isFallback: boolean;
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

/** The tombstone's name for one model. The ONE place that maps model → constant. */
const tombstoneName = (model: OptionModel): string =>
  model === 'department'
    ? TOMBSTONE_DEPARTMENT_NAME
    : TOMBSTONE_PERSONNEL_ROLE_NAME;

const toDto = (model: OptionModel, row: OptionRow): OptionResponse => {
  // A freshly created option has no holders, and `?? 0` says so rather than letting an absent
  // aggregate surface as `undefined` in a field the screen prints.
  const staffCount = row._count?.systemUsers ?? 0;
  const registrationCount = row._count?.registrations ?? 0;
  return {
    id: row.id,
    name: row.name,
    isSystemReserved: row.isSystemReserved,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    holderCount: staffCount + registrationCount,
    staffCount,
    registrationCount,
    /*
     * ⚠️ `isSystemReserved &&` IS LOAD-BEARING, not belt-and-braces. The name is matched only after
     * the flag has already established that this is a system-owned row, so an operator who creates
     * an ordinary option literally called "ไม่พบตำแหน่ง" gets `isFallback: false` and a perfectly
     * normal, editable, assignable row. Matching on the name alone would let anyone mint a row that
     * the pickers refuse to offer and the UI treats as a tombstone — a self-inflicted denial of
     * service costing one create call.
     *
     * The 409 on active names does NOT make that unreachable: the real tombstone is reserved, and
     * `create` is not filtered by `isSystemReserved`, so the collision is with a row that exists —
     * but soft-deleting is not the only path here and relying on a unique index to enforce a
     * SECURITY property is exactly the coupling this comment exists to prevent.
     */
    isFallback: row.isSystemReserved && row.name === tombstoneName(model),
  };
};

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

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
   *
   * ─────────────────────────────────────────────────────────────────────────
   * CACHE-ASIDE (R1). This is the heaviest read on the admin surface and the one every screen with
   * a dropdown makes: `HOLDER_COUNT` is two correlated aggregates PER ROW, over two tables, and it
   * runs again on every page open even though the answer changes a few times a week.
   *
   * `includeReserved` goes into the key via the SAME variable that builds the WHERE clause below,
   * so the cached view and the queried view provably match. Do not "tidy" that into two
   * expressions.
   *
   * The cached value is `OptionResponse[]`, whose dates are already ISO **strings** — so the
   * JSON round trip is lossless. If a `Date` ever reaches this payload, a cache hit would return a
   * string where a miss returns a `Date`, and every consumer would work until the first hit.
   */
  async list(
    model: OptionModel,
    opts: { includeReserved: boolean },
  ): Promise<OptionResponse[]> {
    const key = optionListKey(model, opts.includeReserved);

    const cached = await this.redis.getJson<OptionResponse[]>(key);
    if (cached) return cached;

    const rows = await this.delegate(model).findMany({
      where: opts.includeReserved
        ? { deletedAt: null }
        : { deletedAt: null, isSystemReserved: false },
      select: PUBLIC_SELECT,
      orderBy: { name: 'asc' },
    });
    const dto = rows.map((row) => toDto(model, row));

    await this.redis.setJson(key, dto);
    return dto;
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
      // AFTER the commit, never before: dropping first leaves a window where a concurrent read
      // refills the key from the pre-write state and then nothing drops it again for 300s.
      await this.redis.del(...OPTION_CACHE_KEYS);
      return toDto(model, created);
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
      await this.redis.del(...OPTION_CACHE_KEYS);
      return toDto(model, updated);
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

    // Outside the transaction, so it can only run once the move + delete actually committed.
    // This one write moves TWO counts — the deleted option's holders all land on the tombstone —
    // which is why the whole family goes, not one key.
    await this.redis.del(...OPTION_CACHE_KEYS);
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
