import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { VENUE_WRITE_CACHE_KEYS } from '../redis/cache-keys';
import { R2StorageService } from '../storage/r2-storage.service';
import { TOMBSTONE_VENUE_TYPE_NAME } from '../venue-types/venue-types.constants';
import {
  CLOSE_REASON_REQUIRED,
  INVALID_AMENITY,
  INVALID_PHOTO_URL,
  INVALID_VENUE_TYPE,
  VENUE_ALREADY_IN_STATE,
  VENUE_NAME_TAKEN,
  VENUE_NOT_FOUND,
} from './venues.constants';
import type {
  CreateVenueDto,
  ListVenuesQueryDto,
  UpdateVenueDto,
  VenueResponseDto,
} from './dto/venue.dto';

/**
 * ⚠️ NO `deletedAt` FILTER ON THE NESTED CATEGORY, and that is the READ half of the asymmetry
 * `CLAUDE.md` states for `SystemUser.departmentId`. An existing venue keeps resolving its category
 * name forever, even after that category is soft-deleted. Adding the filter here would return `null`
 * into a non-nullable DTO field and 500 the whole list — the exact failure the note warns about.
 *
 * The amenity ticks DO carry one, and the difference is real rather than an inconsistency: a tick is
 * a claim about the venue RIGHT NOW ("this hall has a projector"). A soft-deleted amenity is one the
 * operators retired, so it must stop printing on cards — and unlike the category there is no
 * non-nullable field left empty by dropping it, because a venue with zero amenities is valid.
 * (`AmenitiesService.softDelete` hard-deletes the tick rows anyway, so this filter is a belt to that
 * braces: it also covers rows a migration or a manual fix might leave behind.)
 */
const PUBLIC_INCLUDE = {
  venueType: { select: { id: true, name: true, isSystemReserved: true } },
  photos: {
    select: { id: true, url: true, position: true },
    // `id` as the tiebreak so a duplicated `position` degrades to a stable but arbitrary order
    // rather than to a different order on every read. See the model comment on why there is no
    // unique constraint to prevent the duplicate in the first place.
    orderBy: [{ position: 'asc' }, { id: 'asc' }] as const,
  },
  amenities: {
    where: { amenity: { deletedAt: null } },
    select: { amenity: { select: { id: true, name: true } } },
    orderBy: { amenity: { name: 'asc' } } as const,
  },
} satisfies Prisma.VenueInclude;

type VenueRow = Prisma.VenueGetPayload<{ include: typeof PUBLIC_INCLUDE }>;

const toDto = (row: VenueRow): VenueResponseDto => ({
  id: row.id,
  name: row.name,
  venueType: {
    id: row.venueType.id,
    name: row.venueType.name,
    // Derived exactly as `/venue-types` derives it — flag AND name, never the name alone. An
    // operator may create an ordinary category literally named `ไม่พบประเภทสถานที่`, and that row
    // must render as the ordinary category it is.
    isFallback:
      row.venueType.isSystemReserved &&
      row.venueType.name === TOMBSTONE_VENUE_TYPE_NAME,
  },
  capacity: row.capacity,
  location: row.location,
  description: row.description,
  isOpen: row.isOpen,
  closedReason: row.closedReason,
  photos: row.photos,
  amenities: row.amenities.map((a) => a.amenity),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * `สถานที่จัดกิจกรรม` — the product's subject table.
 *
 * ⚠️ NOT CACHED, and every write here drops OTHER tables' keys. See `VENUE_WRITE_CACHE_KEYS`: both
 * curated tables count their `holderCount` over `venues` / `venue_amenities`, so a venue write moves
 * numbers on two screens this service never touches.
 *
 * ⚠️ THE SERVICE, NOT THE FK, IS WHAT REFUSES A RETIRED CATEGORY. `onDelete: Restrict` guards HARD
 * deletes only; a soft-deleted category row still physically exists, so Postgres accepts the FK
 * happily. Every write path below therefore re-validates inside its own transaction.
 */
@Injectable()
export class VenuesService {
  private readonly logger = new Logger(VenuesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: R2StorageService,
  ) {}

  /**
   * Everything non-deleted, `name ASC`, with the screen's search and two filters applied server-side.
   *
   * No pagination — see `ListVenuesQueryDto`. `q` matches the NAME or the LOCATION, which is what the
   * search box promises ("ค้นหาจากชื่อสถานที่หรือที่ตั้ง"); matching the description too would return
   * rows whose reason for matching is invisible on the card.
   */
  async list(query: ListVenuesQueryDto): Promise<VenueResponseDto[]> {
    const q = query.q?.trim();
    const rows = await this.prisma.venue.findMany({
      where: {
        deletedAt: null,
        ...(query.venueTypeId ? { venueTypeId: query.venueTypeId } : {}),
        ...(query.status ? { isOpen: query.status === 'open' } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { location: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: PUBLIC_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return rows.map(toDto);
  }

  /** A venue is always created OPEN — the form has no switch in create mode, and neither has this. */
  async create(dto: CreateVenueDto): Promise<VenueResponseDto> {
    const photoUrls = this.assertOwnPhotoUrls(dto.photoUrls ?? []);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.assertAssignableVenueType(tx, dto.venueTypeId);
        await this.assertActiveAmenities(tx, dto.amenityIds ?? []);

        return tx.venue.create({
          data: {
            name: dto.name,
            venueTypeId: dto.venueTypeId,
            capacity: dto.capacity,
            location: dto.location ?? null,
            description: dto.description ?? null,
            photos: {
              createMany: {
                data: photoUrls.map((url, position) => ({ url, position })),
              },
            },
            amenities: {
              createMany: {
                data: (dto.amenityIds ?? []).map((amenityId) => ({
                  amenityId,
                })),
              },
            },
          },
          include: PUBLIC_INCLUDE,
        });
      });

      this.logger.log(`Venue created. id=${created.id}`);
      // After the commit, never before — dropping first leaves a window in which a concurrent read
      // refills the key from the pre-write state and nothing drops it again for the whole TTL.
      await this.redis.del(...VENUE_WRITE_CACHE_KEYS);
      return toDto(created);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /**
   * Partial update of the content fields plus, optionally, the whole amenity set and the whole
   * ordered photo set.
   *
   * ⚠️ `isOpen` CANNOT ARRIVE HERE — it is absent from `UpdateVenueDto`, so `forbidNonWhitelisted`
   * has already answered 400 (AC-S6). Closing is a transition with a mandatory reason; see `close`.
   *
   * ⚠️ AN OMITTED `photoUrls`/`amenityIds` MEANS UNCHANGED, NOT CLEARED. Clearing is `[]`. The form
   * always sends both, so a request that omits one came from somewhere else and almost certainly did
   * not mean to wipe it.
   */
  async update(id: string, dto: UpdateVenueDto): Promise<VenueResponseDto> {
    const photoUrls = dto.photoUrls
      ? this.assertOwnPhotoUrls(dto.photoUrls)
      : undefined;

    const existing = await this.prisma.venue.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(VENUE_NOT_FOUND);

    // Captured BEFORE the write so the objects dropped from the set can be cleaned up after it. Read
    // outside the transaction is fine: only this endpoint rewrites the set, and the cleanup is
    // best-effort by design.
    const before = photoUrls
      ? await this.prisma.venuePhoto.findMany({
          where: { venueId: existing.id },
          select: { url: true },
        })
      : [];

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (dto.venueTypeId !== undefined) {
          await this.assertAssignableVenueType(tx, dto.venueTypeId);
        }
        if (dto.amenityIds !== undefined) {
          await this.assertActiveAmenities(tx, dto.amenityIds);
          // Replace, never merge: the form sends the set it wants to end up with.
          await tx.venueAmenity.deleteMany({ where: { venueId: existing.id } });
          await tx.venueAmenity.createMany({
            data: dto.amenityIds.map((amenityId) => ({
              venueId: existing.id,
              amenityId,
            })),
          });
        }
        if (photoUrls) {
          // ⚠️ DELETE-THEN-RECREATE, not a per-row diff, and this is why `[venueId, position]` has no
          // unique index: renumbering an existing set in place needs either a deferrable constraint
          // or a temporary shuffle through impossible positions. Replacing the whole set is one
          // statement pair with no intermediate state a constraint could object to.
          await tx.venuePhoto.deleteMany({ where: { venueId: existing.id } });
          await tx.venuePhoto.createMany({
            data: photoUrls.map((url, position) => ({
              venueId: existing.id,
              url,
              position,
            })),
          });
        }

        return tx.venue.update({
          where: { id: existing.id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.venueTypeId !== undefined
              ? { venueTypeId: dto.venueTypeId }
              : {}),
            ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
            ...(dto.location !== undefined
              ? { location: dto.location ?? null }
              : {}),
            ...(dto.description !== undefined
              ? { description: dto.description ?? null }
              : {}),
          },
          include: PUBLIC_INCLUDE,
        });
      });

      this.logger.log(`Venue updated. id=${updated.id}`);
      await this.redis.del(...VENUE_WRITE_CACHE_KEYS);

      // Best-effort, AFTER the commit: an object deleted before a failed write would leave a live row
      // pointing at nothing, which is worse than an orphan nobody can see.
      if (photoUrls) {
        const kept = new Set(photoUrls);
        await this.deleteObjectsFor(
          before.map((p) => p.url).filter((url) => !kept.has(url)),
        );
      }
      return toDto(updated);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  /**
   * ปิดชั่วคราว. NOT a soft delete: the venue stays visible to end users and simply stops accepting
   * new booking requests.
   *
   * The reason is mandatory (`CloseVenueDto` makes an empty one a 400 before this runs) because it is
   * READ BY THE PEOPLE IT AFFECTS — it prints on the card and, once LIFF exists, in front of anybody
   * who tries to book the room.
   */
  async close(id: string, reason: string): Promise<VenueResponseDto> {
    const trimmed = reason.trim();
    // Belt to the DTO's braces: `@IsNotEmpty` runs after `@Transform(trim)`, so this is unreachable
    // through the HTTP path. It stays because the invariant "closed implies a reason" is this
    // service's to keep, not the transport layer's.
    if (!trimmed) throw new BadRequestException(CLOSE_REASON_REQUIRED);

    const existing = await this.prisma.venue.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, isOpen: true },
    });
    if (!existing) throw new NotFoundException(VENUE_NOT_FOUND);
    // ⚠️ NOT idempotent, unlike the re-block path on `LineUser`. Closing an already-closed venue
    // would silently REPLACE the reason end users are reading, and the operator who did it saw a
    // screen that said the venue was open. The screen only offers this on an open venue, so a 409
    // here means the record moved underneath them — which is exactly what they need to be told.
    if (!existing.isOpen) throw new ConflictException(VENUE_ALREADY_IN_STATE);

    const updated = await this.prisma.venue.update({
      where: { id: existing.id },
      data: { isOpen: false, closedReason: trimmed },
      include: PUBLIC_INCLUDE,
    });
    this.logger.log(`Venue closed. id=${id}`);
    // The status filter and nothing else — but the keys are dropped anyway, because "which write
    // moves which count" is precisely the thing this repo has decided not to reason about per call.
    await this.redis.del(...VENUE_WRITE_CACHE_KEYS);
    return toDto(updated);
  }

  /** เปิดให้จอง. Clears `closedReason` to NULL — the confirm dialog promises exactly that. */
  async reopen(id: string): Promise<VenueResponseDto> {
    const existing = await this.prisma.venue.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, isOpen: true },
    });
    if (!existing) throw new NotFoundException(VENUE_NOT_FOUND);
    if (existing.isOpen) throw new ConflictException(VENUE_ALREADY_IN_STATE);

    const updated = await this.prisma.venue.update({
      where: { id: existing.id },
      // `null`, never `''`. Two representations of "no reason" in one nullable column is how a
      // reopened venue starts rendering an empty warning strip on its card (AC-S5).
      data: { isOpen: true, closedReason: null },
      include: PUBLIC_INCLUDE,
    });
    this.logger.log(`Venue reopened. id=${id}`);
    await this.redis.del(...VENUE_WRITE_CACHE_KEYS);
    return toDto(updated);
  }

  /**
   * Soft delete. A second DELETE on the same id is a 404, byte-identical to an unknown id.
   *
   * ⚠️ THE PHOTO OBJECTS ARE NOT DELETED FROM THE BUCKET, and that is deliberate rather than
   * forgotten. The row survives so a future `Booking.venueId` keeps resolving a name, the rows in
   * `venue_photos` survive with it, and their URLs stay live — a hard delete here would leave those
   * rows pointing at nothing. What makes it safe is that a soft-deleted venue is invisible to every
   * route, so no screen ever renders those URLs. If a purge is ever built it deletes the rows and the
   * objects together, in that order.
   */
  async softDelete(id: string): Promise<void> {
    const existing = await this.prisma.venue.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(VENUE_NOT_FOUND);

    await this.prisma.venue.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    this.logger.log(`Venue soft-deleted. id=${id}`);
    await this.redis.del(...VENUE_WRITE_CACHE_KEYS);
  }

  /**
   * ACTIVE and NOT RESERVED, or the same 400 an unknown id gets.
   *
   * ⚠️ THE TOMBSTONE IS REFUSED HERE AND ACCEPTED BY THE LIST FILTER, on purpose. It is where venues
   * LAND when their category is deleted, so browsing it is repair work; CHOOSING it would make the
   * row mean two different things. And the refusal is a **400, never a 403** — reserved must be
   * indistinguishable from never-existed (AC-S2 compares the two bodies byte for byte).
   */
  private async assertAssignableVenueType(
    tx: Prisma.TransactionClient,
    venueTypeId: number,
  ): Promise<void> {
    const row = await tx.venueType.findFirst({
      where: { id: venueTypeId, deletedAt: null, isSystemReserved: false },
      select: { id: true },
    });
    if (!row) throw new BadRequestException(INVALID_VENUE_TYPE);
  }

  /** Every id in the set must be an ACTIVE amenity. One count, not N lookups. */
  private async assertActiveAmenities(
    tx: Prisma.TransactionClient,
    amenityIds: number[],
  ): Promise<void> {
    if (amenityIds.length === 0) return;
    const found = await tx.amenity.count({
      where: { id: { in: amenityIds }, deletedAt: null },
    });
    // The DTO's `@ArrayUnique` is what makes this comparison sound — with duplicates allowed, a set
    // of `[3, 3]` would count 1 against a length of 2 and be rejected for the wrong reason.
    if (found !== amenityIds.length) {
      throw new BadRequestException(INVALID_AMENITY);
    }
  }

  /**
   * Every URL must be an object in OUR bucket, under `venues/`.
   *
   * ⚠️ STRICTER THAN THE AVATAR CONTRACT, and `INVALID_PHOTO_URL` says why. Two things depend on it:
   * a venue card can never become a hotlink to a host nobody here controls, and "replace the whole
   * set" can safely delete the objects it dropped, because every one of them is ours to delete.
   *
   * ⚠️ THE CHECK IS SKIPPED WHEN R2 IS UNCONFIGURED, which is not a hole. With no bucket there is no
   * prefix to compare against, `POST /venues/photos` answers 500 before minting anything, and the
   * only URLs that can reach this method are ones somebody typed by hand into an admin-only endpoint.
   * That is also the configuration the e2e suite runs in, which is what lets it exercise photo
   * ordering and the ten-photo ceiling without a bucket.
   */
  private assertOwnPhotoUrls(urls: string[]): string[] {
    const base = this.storage.publicBaseUrl();
    if (!base) return urls;
    const prefix = `${base}/venues/`;
    for (const url of urls) {
      if (!url.startsWith(prefix)) {
        throw new BadRequestException(INVALID_PHOTO_URL);
      }
    }
    return urls;
  }

  /**
   * Best-effort removal of objects that are no longer referenced. NEVER throws: a cleanup failure
   * must not fail a write that has already committed. Same prefix guard as the avatar path — never
   * derive a delete target from a URL that is not ours.
   */
  private async deleteObjectsFor(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    const base = this.storage.publicBaseUrl();
    if (!base) return;

    for (const url of urls) {
      if (!url.startsWith(`${base}/venues/`)) continue;
      await this.storage.deleteObject(url.slice(`${base}/`.length));
    }
  }

  /** A `P2002` from `venues_name_active_key` → 409; anything else is rethrown unchanged. */
  private mapWriteError(error: unknown): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(VENUE_NAME_TAKEN);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
