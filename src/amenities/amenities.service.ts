import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AMENITY_LIST_KEY } from '../redis/cache-keys';
// The 404 and 409 texts are the shared curated-table contract; see the note in
// `venue-types.service.ts`. Nothing else is imported from `src/options/` — this table's DELETE is a
// different operation, not a variation of that one.
import { OPTION_NAME_TAKEN, OPTION_NOT_FOUND } from '../options/options.errors';
import {
  AmenityResponseDto,
  DeleteAmenityResponseDto,
} from './dto/amenity.dto';

/** An `Amenity` row narrowed to the public select. Dates are still `Date`s. */
interface AmenityRow {
  id: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const PUBLIC_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * ⚠️ `isSystemReserved` AND `isFallback` ARE CONSTANTS, NOT COLUMNS — the model has neither, on
 * purpose (see `schema.prisma`). They are on the wire so that the client can render this table with
 * the same component as the other three curated tables; what those screens share is a RESPONSE
 * SHAPE, not a storage shape. Adding the columns "for symmetry" would put a field in the database
 * that no code may ever set to `true`, and a column like that does not stay unused.
 *
 * `holderCount` is hard-zero for the same reason it is on `VenueType`: there are no venues yet, so
 * no amenity is provided anywhere. It becomes `_count` over `VenueAmenity` with VENUE-1.
 */
const toDto = (row: AmenityRow): AmenityResponseDto => ({
  id: row.id,
  name: row.name,
  isSystemReserved: false,
  isFallback: false,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  holderCount: 0,
});

/**
 * Admin CRUD for `Amenity` (อุปกรณ์ที่ให้บริการ).
 *
 * ⚠️ THE ONE CURATED TABLE WITH NO RESERVED ROWS AT ALL, and every difference below follows from
 * that single fact:
 *
 *   · `list` takes no `includeReserved` — there is nothing to hide, so every caller gets the same
 *     rows and the cache is ONE key rather than two.
 *   · `update`/`softDelete` filter only on `deletedAt` — no `isSystemReserved: false` clause, because
 *     the column does not exist. Every row here is ordinary, editable and deletable.
 *   · `softDelete` resolves NO tombstone and can never raise `TOMBSTONE_ROW_MISSING`. An amenity is
 *     a TICK in a join table: deleting one removes ticks and orphans nothing, so there is nowhere to
 *     re-point to and a venue with zero amenities is perfectly valid.
 *
 * ⇒ This table may legitimately be EMPTY, unlike the other three, which are pointed at by required
 * FKs. It also seeds zero rows (`Q18`): the vocabulary belongs to the operators, so there is no
 * correct starting list to collect — only one to avoid inventing.
 */
@Injectable()
export class AmenitiesService {
  private readonly logger = new Logger(AmenitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Non-deleted amenities, `name ASC`. One view for every role — see the class comment. */
  async list(): Promise<AmenityResponseDto[]> {
    const cached =
      await this.redis.getJson<AmenityResponseDto[]>(AMENITY_LIST_KEY);
    if (cached) return cached;

    const rows = await this.prisma.amenity.findMany({
      where: { deletedAt: null },
      select: PUBLIC_SELECT,
      orderBy: { name: 'asc' },
    });
    const dto = rows.map(toDto);

    await this.redis.setJson(AMENITY_LIST_KEY, dto);
    return dto;
  }

  /** Write-then-catch on the partial-unique index: an active-name collision is 409. */
  async create(name: string): Promise<AmenityResponseDto> {
    try {
      const created = await this.prisma.amenity.create({
        data: { name },
        select: PUBLIC_SELECT,
      });
      this.logger.log(`Amenity created. id=${created.id}`);
      await this.redis.del(AMENITY_LIST_KEY);
      return toDto(created);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /** Rename. 404 on unknown/soft-deleted id; 409 on an active-name collision. */
  async update(id: number, name: string): Promise<AmenityResponseDto> {
    const existing = await this.prisma.amenity.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(OPTION_NOT_FOUND);

    try {
      const updated = await this.prisma.amenity.update({
        where: { id: existing.id },
        data: { name },
        select: PUBLIC_SELECT,
      });
      this.logger.log(`Amenity renamed. id=${updated.id}`);
      await this.redis.del(AMENITY_LIST_KEY);
      return toDto(updated);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /**
   * Soft-delete the amenity and RELEASE its ticks — the ticks are hard-deleted, the row is not.
   *
   * ⚠️ THE TWO HALVES ARE DIFFERENT KINDS OF FACT, which is why they are deleted differently. A tick
   * is a claim about a venue RIGHT NOW ("this hall has a projector"); leaving it would keep a
   * deleted amenity printing on venue cards forever. The amenity row itself is kept for the reason
   * every row in this schema is kept: the partial unique index makes the name reusable, and hard
   * deletes buy nothing on a table this size while breaking the one rule the whole schema shares.
   *
   * ⚠️ RETURNS A COUNT, WHERE THE OTHER THREE TABLES RETURN 204. The confirm dialog states how many
   * venues provide this amenity BEFORE the click, so the server must be able to produce that number
   * anyway — and between the two moments somebody else can edit a venue. Returning what actually
   * happened lets the toast confirm the promise rather than repeat it.
   *
   * ⚠️ NO TOMBSTONE RESOLVE, so `TOMBSTONE_ROW_MISSING` is unreachable here by construction — the
   * failure mode `/venue-types` and `/departments` have on an unseeded database simply does not
   * exist on this endpoint.
   */
  async softDelete(id: number): Promise<DeleteAmenityResponseDto> {
    const existing = await this.prisma.amenity.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(OPTION_NOT_FOUND);

    // One transaction, because releasing the ticks and retiring the row is one operation: a failure
    // between them would leave venues advertising an amenity that no longer exists, or an amenity
    // nobody can find still ticked on nine venues.
    await this.prisma.$transaction(async (tx) => {
      await tx.amenity.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      // ⚠️ THE RELEASE LANDS HERE WITH VENUE-1:
      //   await tx.venueAmenity.deleteMany({ where: { amenityId: existing.id } });
      // …and `releasedVenueCount` becomes its `count`. Until `VenueAmenity` exists there is nothing
      // to release and 0 is the true answer, not a stub.
    });

    this.logger.log(`Amenity soft-deleted. id=${id} releasedVenues=0`);
    await this.redis.del(AMENITY_LIST_KEY);
    return { releasedVenueCount: 0 };
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
