import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
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
   * `venues/<32 lowercase hex>.<ext>` — FLAT, with no id segment at all.
   *
   * ⚠️ THE DESIGN LOG SAID `venues/<venueId>/…` AND THAT SHAPE IS UNAVAILABLE, because the PO chose
   * upload-then-bind (option ข, 2026-08-25): the operator picks photos inside the CREATE dialog,
   * where no venue exists yet and therefore no id does either. The alternatives were to split the
   * form into two steps, or to upload into a staging prefix and COPY every object on save — a second
   * R2 round trip per photo that can fail halfway through a write that has already committed.
   *
   * Dropping the id costs less than it looks, and the design log's own erasure paragraph is why: a
   * `<venueId>` prefix does NOT do for venue photos what `<userId>` does for avatars. An erasure
   * request names a PERSON, and a person appears nowhere in either key — so the prefix was never
   * going to make a face findable. What it would have bought is "purge one venue's objects in one
   * call", and venues are soft-deleted, never purged.
   *
   * What the flat prefix does buy, and what the orphan sweep needs: every venue photo the system has
   * ever minted is under one `venues/` prefix, so "objects with no row" is one `ListObjectsV2` and
   * one query — easier, not harder, than if abandoned uploads were scattered under per-venue folders
   * that a cancelled create would never have produced anyway.
   *
   * 128 bits of `randomBytes(16)` — UNGUESSABLE, for the same reason as the avatar key: the bucket
   * is public-read, so enumerability is the whole threat.
   */
  buildVenuePhotoKey(type: AvatarImageType): string {
    return `venues/${randomBytes(16).toString('hex')}.${EXTENSION[type]}`;
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
