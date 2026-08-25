import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isAvatarImageType, sniffImageType } from '../storage/image-sniff';
import { R2StorageService } from '../storage/r2-storage.service';
import {
  INVALID_PHOTO_URL,
  VENUE_PHOTO_IN_USE,
  VENUE_PHOTO_REQUIRED,
  VENUE_PHOTO_TYPE_UNSUPPORTED,
} from './venues.constants';
import type { VenuePhotoUploadResponseDto } from './dto/venue.dto';

/**
 * `POST /venues/photos` and `DELETE /venues/photos` — the UNBOUND half of the photo lifecycle.
 *
 * ── Why the upload has no `:id` (PO, 2026-08-25 · option ข) ──────────────────────────────────────
 * The design log specified `POST /venues/:id/photos` with keys under `venues/<venueId>/`. The
 * prototype's form contradicts that: photos are picked inside the CREATE dialog, where no venue
 * exists yet. Three ways out were put to the PO —
 *
 *   ก  create the venue first, then allow photos  → splits one form into two steps
 *   ข  upload now, bind on save                   → CHOSEN
 *   ค  send the bytes with `POST /venues`         → multipart+JSON in one body, no precedent here
 *
 * ── The cost of ข, stated plainly ───────────────────────────────────────────────────────────────
 * An operator who uploads a photo and then presses ยกเลิก leaves an object in the bucket that no row
 * references. `DELETE /venues/photos` exists so the dialog can clean up after itself on cancel, which
 * covers the ordinary case; a closed tab or a lost connection still leaves one behind. Those are
 * invisible, cheap, and collectable later — every venue photo the system has ever minted is under one
 * flat `venues/` prefix, so "objects with no row" is one `ListObjectsV2` plus one query.
 *
 * ⚠️ NO SWEEP JOB EXISTS YET. This is a known, bounded leak, not a solved problem.
 */
@Injectable()
export class VenuePhotoUploadService {
  private readonly logger = new Logger(VenuePhotoUploadService.name);

  constructor(
    private readonly storage: R2StorageService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Validation order, all mandatory and identical to the avatar path — because the threat is
   * identical and the reasoning is written out there:
   *   1. non-empty (size is already capped upstream by multer, whose `MulterError` the route's filter
   *      maps to 400 rather than the 413 Nest would otherwise produce);
   *   2. declared MIME — a cheap first filter, NOT a control, since the client wrote it;
   *   3. magic bytes — THE control, and they must AGREE with the declaration.
   *
   * `originalname` is ignored entirely: attacker-controlled, and the classic path-traversal /
   * double-extension vector. Both the stored ContentType and the key's extension come from the
   * SNIFFED type.
   *
   * ⚠️ `isAvatarImageType` / `AvatarImageType` ARE NAMED FOR THEIR FIRST CALLER, not for their scope.
   * The allowlist (jpeg/png/webp) is the same one, and forking it would create two lists free to
   * drift apart.
   */
  async upload(
    file: Express.Multer.File,
  ): Promise<VenuePhotoUploadResponseDto> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException(VENUE_PHOTO_REQUIRED);
    }
    if (!isAvatarImageType(file.mimetype)) {
      throw new BadRequestException(VENUE_PHOTO_TYPE_UNSUPPORTED);
    }
    const sniffed = sniffImageType(file.buffer);
    if (!sniffed || sniffed !== file.mimetype) {
      throw new BadRequestException(VENUE_PHOTO_TYPE_UNSUPPORTED);
    }

    const key = this.storage.buildVenuePhotoKey(sniffed);
    await this.storage.putImage(key, file.buffer, sniffed);

    // Key only — never the bytes, and no operator identity beside it. Matches the avatar path's
    // `id=`-only logging discipline.
    this.logger.log(`Venue photo uploaded. key=${key}`);
    return { url: this.storage.publicUrlFor(key) };
  }

  /**
   * Discard an object the operator uploaded and then abandoned.
   *
   * ⚠️ IT REFUSES ANY URL A VENUE STILL REFERENCES, and that guard is what makes the endpoint safe to
   * expose at all. Without it this would be "delete any venue photo by URL" — which would leave a
   * live `venue_photos` row pointing at a dead object, a state nothing else in this schema can
   * produce. With it, the endpoint can only ever remove bytes nothing points at.
   *
   * The check-then-delete race is unreachable rather than merely narrow: the URL carries 128 random
   * bits and is returned to exactly one caller, so nobody else can be binding it in between.
   *
   * The prefix guard is the second half — never derive a delete target from a URL that is not ours.
   * A foreign URL is the same 400 as a malformed one, so this cannot be used to probe the bucket base.
   */
  async discard(url: string): Promise<void> {
    const base = this.storage.publicBaseUrl();
    if (!base || !url.startsWith(`${base}/venues/`)) {
      throw new BadRequestException(INVALID_PHOTO_URL);
    }

    const referenced = await this.prisma.venuePhoto.findFirst({
      where: { url },
      select: { id: true },
    });
    if (referenced) throw new ConflictException(VENUE_PHOTO_IN_USE);

    const deleted = await this.storage.deleteObject(
      url.slice(`${base}/`.length),
    );
    // `deleteObject` is best-effort and never throws, and R2 answers success for a key that was never
    // there. So `false` means the SDK call itself failed — worth a line, but not a failed request:
    // the object is unreferenced either way and a sweep would find it.
    if (!deleted) this.logger.warn('Venue photo discard failed (ignored).');
  }
}
