import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { sniffImageType } from '../storage/image-sniff';
import { R2StorageService } from '../storage/r2-storage.service';
import type { FeedbackPhotoUploadResponseDto } from './dto/feedback.dto';
import { resolveAllowedReporter } from './feedback-reporter';
import {
  FEEDBACK_PHOTO_REQUIRED,
  FEEDBACK_PHOTO_TYPE_UNSUPPORTED,
  isFeedbackPhotoType,
} from './feedback.constants';

/**
 * `POST /line-users/feedback/photos` — the client uploads each photo as it is picked (AC-23) and
 * sends the returned URLs in `photos[]` on the submit call.
 *
 * ── WHY THIS IS A NEW ROUTE RATHER THAN `POST /venues/photos` ──
 * That one is `@Roles(SUPER_ADMIN, ADMIN)` behind `SessionGuard` and is unreachable with a LINE ID
 * token. Everything else about it is copied deliberately: memory storage, the exclusive multer
 * limit, the 400-not-413 filter, and the magic-byte sniff below.
 *
 * ── WHAT IS DELIBERATELY MISSING ──
 * There is no discard endpoint and no re-home step. A photo uploaded and then abandoned (the user
 * closes LINE mid-form) stays in the bucket: bounded at ≤ 3 objects × ≤ 5 MB per abandoned form, by
 * an APPROVED user, on a screen that is not high-traffic. It is cheap, invisible, and collectable
 * later by a sweep that does not exist yet — and which the flat key layout makes SIMPLER, not
 * harder (see `FEEDBACK_PHOTO_PREFIX`). 🔴 The nightly `venues/_new/` sweep must never be pointed
 * at this prefix: these objects are live forever, not staged.
 */
@Injectable()
export class FeedbackPhotoService {
  private readonly logger = new Logger(FeedbackPhotoService.name);

  constructor(
    private readonly storage: R2StorageService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Validation order, all four steps mandatory:
   *
   *   1. WHO — `ALLOWED` or a 403. ⚠️ ADDED BEYOND AC-35'S LITERAL WORDING, WITH REASON: that AC
   *      names the submit route, but this one writes 5 MB objects into a public-read bucket, and
   *      leaving it open to any token-bearing `PENDING`/`BLOCKED` follower makes it free storage
   *      for anyone who has ever added the OA. The identity is not used for anything else — the key
   *      deliberately carries no user id.
   *   2. non-empty (size is already capped upstream by multer, whose error the route's filter maps
   *      to 400 rather than the 413 Nest would otherwise produce);
   *   3. declared MIME — a cheap first filter, NEVER the control, since the client wrote it;
   *   4. magic bytes — THE control, and they must AGREE with the declaration.
   *
   * `originalname` is ignored ENTIRELY: attacker-controlled, and the classic path-traversal /
   * double-extension vector. Both the stored ContentType and the key's extension come from the
   * SNIFFED type. AC-39's two cases fall straight out — a `.png`-named JPEG declared `image/jpeg`
   * is stored as JPEG, and a `.jpg`-named PDF is a 400.
   *
   * ⚠️ `isAvatarImageType` IS NOT REUSED HERE, and that is the one deliberate difference from the
   * venue path: it accepts webp, AC-39 allows JPEG and PNG only, and the client rejects webp before
   * upload. `sniffImageType` itself is reused unchanged — only the allowlist is local.
   */
  async upload(
    lineSub: string,
    file: Express.Multer.File,
  ): Promise<FeedbackPhotoUploadResponseDto> {
    await resolveAllowedReporter(this.prisma, lineSub);

    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException(FEEDBACK_PHOTO_REQUIRED);
    }
    if (!isFeedbackPhotoType(file.mimetype)) {
      throw new BadRequestException(FEEDBACK_PHOTO_TYPE_UNSUPPORTED);
    }
    const sniffed = sniffImageType(file.buffer);
    if (
      !sniffed ||
      !isFeedbackPhotoType(sniffed) ||
      sniffed !== file.mimetype
    ) {
      throw new BadRequestException(FEEDBACK_PHOTO_TYPE_UNSUPPORTED);
    }

    const key = this.storage.buildFeedbackPhotoKey(sniffed);
    await this.storage.putImage(key, file.buffer, sniffed);

    // Key only — never the bytes, never the filename, and no reporter identity beside it. The same
    // logging discipline the avatar and venue-photo paths hold, and here it is also PDPA: a photo
    // attributable to a named reporter is exactly what must not end up in a log aggregator.
    this.logger.log(`Feedback photo uploaded. key=${key}`);
    return { url: this.storage.publicUrlFor(key) };
  }
}
