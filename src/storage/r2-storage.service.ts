import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { IMAGE_UPLOAD_FAILED, STORAGE_NOT_CONFIGURED } from './storage.errors';
import type { AvatarImageType } from './image-sniff';

/**
 * R2 accepts ONLY this region. A code constant, not an env var: a var whose single valid value is a
 * constant is a misconfiguration vector, not a knob.
 */
const R2_REGION = 'auto';

/**
 * Where a venue photo lands before a venue owns it. Trailing slash included so callers never have to
 * remember it.
 *
 * ⚠️ IT LIVES HERE, NOT IN `venues.constants.ts`. This module is the only thing in the repo that
 * knows what an object key looks like — putting half a key shape in a feature module is how the two
 * halves drift and a `startsWith` check quietly stops matching.
 */
export const VENUE_PHOTO_STAGING_PREFIX = 'venues/_new/';

/** The extension stored in the object key, derived from the SNIFFED type — never `originalname`. */
const EXTENSION: Record<AvatarImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * THE sole seam onto `@aws-sdk/client-s3`. Nothing else in the repo imports the SDK, so tests mock
 * this service rather than the SDK, and swapping R2 for anything else touches exactly one file.
 *
 * The backend never FETCHES a URL here — it only ever writes to a bucket named by config, never by a
 * request. There is no SSRF surface.
 */
@Injectable()
export class R2StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private client?: S3Client;

  constructor(private readonly config: ConfigService) {}

  /** True when all five R2 vars are set (env validation guarantees all-or-nothing). */
  isConfigured(): boolean {
    return (
      this.config.get<string>('R2_ACCOUNT_ID') !== undefined &&
      this.config.get<string>('R2_ACCESS_KEY_ID') !== undefined &&
      this.config.get<string>('R2_SECRET_ACCESS_KEY') !== undefined &&
      this.config.get<string>('R2_BUCKET') !== undefined &&
      this.publicBaseUrl() !== undefined
    );
  }

  publicBaseUrl(): string | undefined {
    return this.config.get<string>('R2_PUBLIC_BASE_URL');
  }

  /**
   * Lazily constructed so a dev box without R2 config still boots (mirrors `LineIdTokenGuard`'s
   * stance on an unset `LINE_LOGIN_CHANNEL_ID`: optional in dev, a request-time 500, logged clearly).
   */
  private s3(): S3Client {
    if (!this.isConfigured()) {
      this.logger.error(
        'R2 is not configured — set the five R2_* vars. Avatar and venue-photo upload are unavailable.',
      );
      throw new InternalServerErrorException(STORAGE_NOT_CONFIGURED);
    }
    if (!this.client) {
      const accountId = this.config.getOrThrow<string>('R2_ACCOUNT_ID');
      this.client = new S3Client({
        region: R2_REGION,
        // Derived, never configured — one less var, one less way for the two to disagree.
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
          secretAccessKey: this.config.getOrThrow<string>(
            'R2_SECRET_ACCESS_KEY',
          ),
        },
      });
    }
    return this.client;
  }

  /**
   * `avatars/<systemUserId>/<32 lowercase hex>.<ext>`
   *
   * The filename is 128 bits of `crypto.randomBytes(16)` — UNGUESSABLE. The bucket is public-read, so
   * avatar URLs are unauthenticated and enumerability is the whole threat; `/<userId>.jpg` would be
   * trivially enumerable from any list response and is explicitly forbidden (plan §8 — avatars are
   * PII, a face being biometric-adjacent).
   *
   * The `<systemUserId>` prefix (itself a cuid, not enumerable) buys a cheap `ListObjectsV2` by
   * prefix — exactly what a future `AUTH-ERASURE` needs to purge one person's objects in one call.
   *
   * A NEW random key every upload (never overwrite in place): cache-busting is free, and no CDN or
   * browser can serve a stale avatar.
   */
  buildAvatarKey(systemUserId: string, type: AvatarImageType): string {
    return `avatars/${systemUserId}/${randomBytes(16).toString('hex')}.${EXTENSION[type]}`;
  }

  /**
   * `venues/_new/<32 lowercase hex>.<ext>` — where an upload LANDS, before any venue owns it.
   *
   * ⚠️ IT IS NOT WHERE THE PHOTO ENDS UP. `VenuesService` re-homes it to
   * `venues/<venueId>/<same filename>` once the venue is written (PO, 25 ส.ค. 2569: *"เพิ่มโฟลเดอร์
   * ของสถานที่นั้นมาอีกชั้น รูปจะได้ไม่ปนกัน"*). The staging step exists because the operator picks
   * photos inside the CREATE dialog, where no venue exists and therefore no id does — upload-then-bind
   * (`D-VN10`) is what the form requires, and this is the price of also getting a per-venue folder.
   *
   * `_new` cannot collide with a real folder: a cuid never starts with an underscore. It also sorts
   * ahead of every venue id in a console listing, so "what has not been claimed yet" is visible at a
   * glance — which is what the orphan sweep will want.
   *
   * 128 bits of `randomBytes(16)` — UNGUESSABLE, for the same reason as the avatar key: the bucket is
   * public-read, so enumerability is the whole threat. The filename carries all of that entropy, so
   * the folder never has to be secret.
   */
  buildVenuePhotoKey(type: AvatarImageType): string {
    return `${VENUE_PHOTO_STAGING_PREFIX}${randomBytes(16).toString('hex')}.${EXTENSION[type]}`;
  }

  /**
   * The same object, under the venue that now owns it. Filename is preserved — it is the part that
   * carries the entropy, and keeping it makes a staging key and its final key obviously the same
   * photo when both turn up in a listing.
   */
  venuePhotoKeyFor(venueId: string, stagingKey: string): string {
    return `venues/${venueId}/${stagingKey.slice(VENUE_PHOTO_STAGING_PREFIX.length)}`;
  }

  /** Is this key still sitting in the staging folder, i.e. does it need re-homing? */
  isStagedVenuePhotoKey(key: string): boolean {
    return key.startsWith(VENUE_PHOTO_STAGING_PREFIX);
  }

  /**
   * Server-side copy. `MetadataDirective` defaults to COPY, so the sniffed `ContentType` set at
   * upload survives — re-declaring it here would be a second place for it to drift.
   *
   * Returns whether it worked rather than throwing, because the caller runs this AFTER the database
   * write has already committed. A failed copy leaves the row pointing at the staging object, which
   * still resolves; a thrown error would turn "the photo is in the wrong folder" into "the save
   * failed", which is a far worse answer to the same event.
   */
  async copyObject(fromKey: string, toKey: string): Promise<boolean> {
    try {
      await this.s3().send(
        new CopyObjectCommand({
          Bucket: this.config.getOrThrow<string>('R2_BUCKET'),
          // ⚠️ `CopySource` IS BUCKET-QUALIFIED AND URI-ENCODED, unlike `Key`. Passing a bare key
          // here is the classic mistake and surfaces as a NoSuchKey for an object that plainly
          // exists.
          CopySource: encodeURI(
            `${this.config.getOrThrow<string>('R2_BUCKET')}/${fromKey}`,
          ),
          Key: toKey,
        }),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `R2 copyObject failed (ignored). from=${fromKey} to=${toKey} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** The durable, public https URL for a key. */
  publicUrlFor(key: string): string {
    return `${this.config.getOrThrow<string>('R2_PUBLIC_BASE_URL')}/${key}`;
  }

  /**
   * `ContentType` is the SNIFFED type, passed by the caller — never the client-declared
   * `file.mimetype` and never derived from `originalname`.
   *
   * An upload failure is a `502`: R2 is an upstream, and the condition is retryable. Mirrors the
   * module-wide "upstream failed → BadGateway" convention.
   *
   * ⚠️ RENAMED FROM `putAvatar` WITH VENUE-1. It never had anything avatar-specific in it — the key
   * and the content type both arrive as arguments — and a venue photo going through a method called
   * `putAvatar` is the kind of name that survives long enough to mislead somebody reading a stack
   * trace. The two CALLERS stay distinct; only this seam is shared.
   */
  async putImage(
    key: string,
    body: Buffer,
    contentType: AvatarImageType,
  ): Promise<void> {
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.config.getOrThrow<string>('R2_BUCKET'),
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(
        `R2 putObject failed. key=${key} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(IMAGE_UPLOAD_FAILED);
    }
  }

  /**
   * Best-effort delete. NEVER throws: cleanup must not fail a request that has already succeeded.
   * Returns whether the delete actually went through, which the specs assert on.
   */
  async deleteObject(key: string): Promise<boolean> {
    try {
      await this.s3().send(
        new DeleteObjectCommand({
          Bucket: this.config.getOrThrow<string>('R2_BUCKET'),
          Key: key,
        }),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `R2 deleteObject failed (ignored). key=${key} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
