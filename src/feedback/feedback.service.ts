import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Feedback } from '@prisma/client';
import { isCodeCollision } from '../bookings/booking-code';
import { PrismaService } from '../prisma/prisma.service';
import {
  FEEDBACK_PHOTO_PREFIX,
  R2StorageService,
} from '../storage/r2-storage.service';
import type {
  CreateFeedbackDto,
  FeedbackResponseDto,
} from './dto/feedback.dto';
import { nextFeedbackCode } from './feedback-code';
import { resolveAllowedReporter } from './feedback-reporter';
import {
  FEEDBACK_CODE_MAX_ATTEMPTS,
  FEEDBACK_PHOTO_URL_INVALID,
  FEEDBACK_VENUE_INVALID,
} from './feedback.constants';

/**
 * `POST /line-users/feedback` — the write half of `CLIENT-ISSUE-1`.
 *
 * 🔴 PDPA, AND IT GOVERNS EVERY LOG LINE IN THIS FILE. `subject` and `description` are
 * user-authored free text that may name people, and the photos are user-generated content of
 * unknown contents. Nothing here logs either, the same discipline `BookingRequest.purpose` carries;
 * the one log line below carries an attempt number and nothing else. The `U…` LINE subject reaches
 * no column and no response body.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: R2StorageService,
  ) {}

  /**
   * Order is fixed, and each step answers a different question:
   *
   *   1. WHO — the `U…` sub becomes a cuid, or a 403 (`resolveAllowedReporter`, AC-34/AC-35).
   *   2. WHERE — an optional venue must exist and not be soft-deleted, else a **400** (E-5).
   *   3. WHAT — every photo URL must be one of ours, else a **400**.
   *   4. WRITE — the code is counted and the row inserted in one transaction, retried on a
   *      `P2002` over `code` (see {@link insertWithCode}).
   */
  async create(
    lineSub: string,
    dto: CreateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    const reporter = await resolveAllowedReporter(this.prisma, lineSub);

    // `null` and absent are the SAME input — both mean ปัญหาทั่วไป / ไม่ระบุสถานที่ — so only a
    // non-empty string is looked up, and the lookup's failure is a 400 rather than a 404: the venue
    // is an INPUT to this write, not the resource being addressed.
    const venue =
      typeof dto.venueId === 'string' && dto.venueId.length > 0
        ? await this.prisma.venue.findFirst({
            // ⚠️ NO `isOpen` FILTER. A closed venue is exactly the venue somebody needs to report a
            // problem about; `VENUE_CLOSED` belongs to booking, not to reporting.
            where: { id: dto.venueId, deletedAt: null },
            select: { id: true, name: true },
          })
        : null;
    if (dto.venueId && !venue) {
      throw new BadRequestException(FEEDBACK_VENUE_INVALID);
    }

    const photos = dto.photos ?? [];
    this.assertOwnPhotoUrls(photos);

    const row = await this.insertWithCode(
      reporter.id,
      venue?.id ?? null,
      dto,
      photos,
    );
    return toResponseDto(row, venue?.name ?? null);
  }

  /**
   * 🔴 NEVER TRUST A URL THAT IS NOT OURS. Every entry must start with this deployment's public
   * base plus the `feedback/` prefix — the same guard `VenuePhotoUploadService.discard` applies,
   * and the reason is sharper here: an admin screen will render this column, so an unchecked entry
   * is an attacker-chosen link on a staff member's screen (and, with a `<img>`, an attacker-chosen
   * request from it).
   *
   * An unconfigured bucket makes every URL invalid rather than making the check pass — a missing
   * base must never widen an allowlist.
   */
  private assertOwnPhotoUrls(urls: readonly string[]): void {
    if (urls.length === 0) return;
    const base = this.storage.publicBaseUrl();
    const prefix = `${base}/${FEEDBACK_PHOTO_PREFIX}`;
    if (!base || !urls.every((url) => url.startsWith(prefix))) {
      throw new BadRequestException(FEEDBACK_PHOTO_URL_INVALID);
    }
  }

  /**
   * The write, wrapped in the retry the `code` column's uniqueness needs.
   *
   * ⚠️ THE RETRY IS AROUND THE WHOLE TRANSACTION, not inside it — `BookingsService.insertWithCode`'s
   * rule, for the same mechanical reason: a `P2002` aborts the transaction, so only a NEW one can
   * re-count and see the row that beat it.
   */
  private async insertWithCode(
    lineUserId: string,
    venueId: string | null,
    dto: CreateFeedbackDto,
    photos: string[],
  ): Promise<Feedback> {
    for (let attempt = 1; attempt <= FEEDBACK_CODE_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.insertOnce(lineUserId, venueId, dto, photos);
      } catch (err) {
        if (!isCodeCollision(err) || attempt === FEEDBACK_CODE_MAX_ATTEMPTS) {
          throw err;
        }
        // Attempt number ONLY — `subject`, `description` and the photo URLs are all PII.
        this.logger.warn(
          `Feedback code collision; retrying (attempt ${attempt}).`,
        );
      }
    }
    // Unreachable: the loop either returns or rethrows on its last attempt.
    throw new InternalServerErrorException();
  }

  private insertOnce(
    lineUserId: string,
    venueId: string | null,
    dto: CreateFeedbackDto,
    photos: string[],
  ): Promise<Feedback> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Counted INSIDE the transaction, so the count and the insert see one snapshot.
      const code = await nextFeedbackCode(tx, dto.type, now);

      return tx.feedback.create({
        data: {
          code,
          type: dto.type,
          // 🔴 THE CUID, never the `U…` sub (AC-34).
          lineUserId,
          // `null` IS the persisted meaning of ปัญหาทั่วไป / ไม่ระบุสถานที่ (AC-10).
          venueId,
          subject: dto.subject,
          description: dto.description,
          photos,
          // `status` is NOT written here: on insert the column's `@default(PENDING)` is its only
          // writer, and every later transition belongs to the admin console (`AdminFeedbackService`).
        },
      });
    });
  }
}

/**
 * ⚠️ `venueName` COMES FROM THE LOOKUP, NOT FROM A SECOND READ. The row carries only `venueId`, and
 * re-reading the venue after the insert would be a query for a value the caller already resolved.
 */
function toResponseDto(
  row: Feedback,
  venueName: string | null,
): FeedbackResponseDto {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    venueId: row.venueId,
    venueName,
    subject: row.subject,
    description: row.description,
    photos: row.photos,
    createdAt: row.createdAt.toISOString(),
  };
}
