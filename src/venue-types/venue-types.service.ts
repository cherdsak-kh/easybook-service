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
import { VENUE_TYPE_CACHE_KEYS, venueTypeListKey } from '../redis/cache-keys';
// Imported, not re-typed. These two messages ARE the option contract — an unknown id and a
// name collision must answer identically on every curated table, and copying the strings is how two
// screens end up disagreeing about what a 404 says. (`TOMBSTONE_ROW_MISSING` is deliberately NOT
// imported: its text names the wrong seed command for this table. See `venue-types.constants.ts`.)
import { OPTION_NAME_TAKEN, OPTION_NOT_FOUND } from '../options/options.errors';
import {
  TOMBSTONE_VENUE_TYPE_NAME,
  VENUE_TYPE_TOMBSTONE_ROW_MISSING,
} from './venue-types.constants';
import { VenueTypeResponseDto } from './dto/venue-type.dto';

/** A `VenueType` row narrowed to the public select. Dates are still `Date`s. */
interface VenueTypeRow {
  id: number;
  name: string;
  isSystemReserved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PUBLIC_SELECT = {
  id: true,
  name: true,
  isSystemReserved: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * ⚠️ `holderCount` IS HARD-ZERO UNTIL THE `Venue` TABLE EXISTS, and it is a real answer rather than a
 * stub: the system contains no venues at all, so no category holds any. When `Venue` lands
 * (VENUE-1) this becomes `_count: { select: { venues: { where: { deletedAt: null } } } }` on the
 * select above and this function disappears; nothing in the DTO or the client changes.
 *
 * It is a named function and not an inline `0` so that grepping `venueCountOf` finds the one place
 * that has to change. It takes no argument yet — there is no row field to read — and gains `row`
 * when the `_count` arrives.
 */
const venueCountOf = (): number => 0;

const toDto = (row: VenueTypeRow): VenueTypeResponseDto => ({
  id: row.id,
  name: row.name,
  isSystemReserved: row.isSystemReserved,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  holderCount: venueCountOf(),
  /*
   * ⚠️ `isSystemReserved &&` GUARDS AGAINST A NAME MATCH ALONE — and the honest statement of its
   * value is narrower than `OptionsService`'s comment might suggest, so here it is precisely.
   *
   * Today the attack it blocks is UNREACHABLE through the API: the partial unique index refuses a
   * second ACTIVE row named `ไม่พบประเภทสถานที่`, and the real tombstone can never be soft-deleted
   * (reserved rows are a 404 on DELETE for every role), so no ordinary row can hold that name while
   * the tombstone exists. Without the flag, matching on the name alone would let anyone mint a row
   * the pickers refuse to offer — a denial of service costing one create call.
   *
   * It stays because the alternative is to make a UNIQUE INDEX the thing that enforces it. That is
   * the coupling worth refusing: the index exists for name reuse after soft-delete, nothing declares
   * it as a security control, and a future decision to relax it (per-school scoping, say) would
   * silently open the hole. A one-token guard that does not depend on another mechanism's side
   * effect is cheaper than the sentence explaining why it was safe to omit.
   */
  isFallback: row.isSystemReserved && row.name === TOMBSTONE_VENUE_TYPE_NAME,
});

/**
 * Admin CRUD for `VenueType` (ประเภทสถานที่). Soft-delete only.
 *
 * ⚠️ A SEPARATE SERVICE FROM `OptionsService` RATHER THAN A THIRD `OptionModel`, and it does not
 * compile as one: `OptionDelegate` is a hand-written interface standing in for two byte-identical
 * Prisma delegates (a union of the real, heavily overloaded ones is not callable), and this table
 * differs in the two places that interface hard-codes — the `_count` is over venues rather than over
 * `systemUsers` + `registrations`, and `softDelete` re-points a different column on a different
 * table. The duplication is known and tracked as **OPT-EXTRACT-1**, to be extracted only once this
 * is green: it carries three security properties (the `isSystemReserved &&` guard, reserved-is-404
 * for every role, and `includeReserved` as a WHERE clause rather than a post-fetch filter), and
 * refactoring those while also introducing them is how one of the three quietly goes missing.
 */
@Injectable()
export class VenueTypesService {
  private readonly logger = new Logger(VenueTypesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Non-deleted categories, `name ASC`.
   *
   * `includeReserved` is REQUIRED and deliberately non-defaulted — a `= false` default would be safe
   * but would let a new call site forget the decision exists. It is a BOOLEAN, never a role: the
   * role→capability decision is `mayUseSystemReservedOptions(actor)` and is made in the controller,
   * so this module stays free of `SystemRole` (AC-X fails the build if a token appears here).
   *
   * The filter is a WHERE clause, not a post-fetch drop: the controller must never hold a row it is
   * not allowed to return. Filtering after the read is one `console.log`, one future `find()`, one
   * debug endpoint away from a leak.
   *
   * The same variable builds the cache key and the WHERE clause, so the cached view and the queried
   * view provably match. Do not "tidy" that into two expressions.
   */
  async list(opts: {
    includeReserved: boolean;
  }): Promise<VenueTypeResponseDto[]> {
    const key = venueTypeListKey(opts.includeReserved);

    const cached = await this.redis.getJson<VenueTypeResponseDto[]>(key);
    if (cached) return cached;

    const rows = await this.prisma.venueType.findMany({
      where: opts.includeReserved
        ? { deletedAt: null }
        : { deletedAt: null, isSystemReserved: false },
      select: PUBLIC_SELECT,
      orderBy: { name: 'asc' },
    });
    const dto = rows.map(toDto);

    // Dates are already ISO strings in `dto`, so the JSON round trip is lossless. A `Date` reaching
    // this payload would make a cache hit return a string where a miss returns a `Date`, and every
    // consumer would work until the first hit.
    await this.redis.setJson(key, dto);
    return dto;
  }

  /** Write-then-catch on the partial-unique index: an active-name collision is 409. */
  async create(name: string): Promise<VenueTypeResponseDto> {
    try {
      const created = await this.prisma.venueType.create({
        data: { name },
        select: PUBLIC_SELECT,
      });
      this.logger.log(`Venue type created. id=${created.id}`);
      // AFTER the commit, never before: dropping first leaves a window where a concurrent read
      // refills the key from the pre-write state and then nothing drops it again for the whole TTL.
      await this.redis.del(...VENUE_TYPE_CACHE_KEYS);
      return toDto(created);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /**
   * Rename. 404 on unknown/soft-deleted id; 409 on an active-name collision.
   *
   * A RESERVED target is also a 404 — for EVERY role, SUPER_ADMIN included. The tombstone is not
   * CRUD-managed: `softDelete` resolves it BY NAME, so a rename would make the next delete fail to
   * find a row that still exists. For an ADMIN the uniform 404 is additionally mandatory — a
   * distinct 403 would be an existence oracle, and reserved must be indistinguishable from
   * never-existed.
   */
  async update(id: number, name: string): Promise<VenueTypeResponseDto> {
    const existing = await this.prisma.venueType.findFirst({
      where: { id, deletedAt: null, isSystemReserved: false },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(OPTION_NOT_FOUND);

    try {
      const updated = await this.prisma.venueType.update({
        where: { id: existing.id },
        data: { name },
        select: PUBLIC_SELECT,
      });
      this.logger.log(`Venue type renamed. id=${updated.id}`);
      await this.redis.del(...VENUE_TYPE_CACHE_KEYS);
      return toDto(updated);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /**
   * Soft-delete (`update` setting `deletedAt`, NEVER a hard delete). A second delete on the same id
   * is a 404, byte-identical to an unknown id. A reserved target is likewise a 404 for every role.
   *
   * ⚠️ THE TOMBSTONE IS RESOLVED UNCONDITIONALLY, even though there are no venues to move yet.
   * Making the resolve conditional on "are there holders" would mean a delete succeeds today and
   * 500s later, on a system whose only difference is unrelated data — the misconfiguration would
   * hide until the first category that happens to hold a venue. Failing on the first delete instead
   * points at the actual defect: migrated but never seeded.
   */
  async softDelete(id: number): Promise<void> {
    const existing = await this.prisma.venueType.findFirst({
      where: { id, deletedAt: null, isSystemReserved: false },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(OPTION_NOT_FOUND);

    const fallbackId = await this.resolveTombstoneId();

    // A transaction even though it currently holds one statement: the re-point of `Venue.venueTypeId`
    // lands here with VENUE-1 and MUST be in the same commit as the delete. Order will be move-then-
    // delete, matching `OptionsService.softDelete` — deleting first leaves a window where live rows
    // reference a soft-deleted category.
    await this.prisma.$transaction(async (tx) => {
      await tx.venueType.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      this.logger.log(
        `Venue type soft-deleted. id=${id} fallbackId=${fallbackId} movedVenues=0`,
      );
    });

    // Outside the transaction, so it can only run once the delete actually committed.
    await this.redis.del(...VENUE_TYPE_CACHE_KEYS);
  }

  /**
   * The row a deleted category's venues are moved to. Resolved by name, ACTIVE and RESERVED — the
   * same probe shape the seed script uses to create it.
   */
  private async resolveTombstoneId(): Promise<number> {
    const row = await this.prisma.venueType.findFirst({
      where: {
        name: TOMBSTONE_VENUE_TYPE_NAME,
        deletedAt: null,
        isSystemReserved: true,
      },
      select: { id: true },
    });
    if (!row) {
      throw new InternalServerErrorException(VENUE_TYPE_TOMBSTONE_ROW_MISSING);
    }
    return row.id;
  }

  /** A `P2002` from the partial-unique index → 409; anything else is rethrown unchanged. */
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
