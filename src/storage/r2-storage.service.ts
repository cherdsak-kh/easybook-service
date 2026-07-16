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
import { AVATAR_UPLOAD_FAILED, R2_NOT_CONFIGURED } from './storage.errors';
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
        'R2 is not configured — set the five R2_* vars. Avatar upload is unavailable.',
      );
      throw new InternalServerErrorException(R2_NOT_CONFIGURED);
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
   */
  async putAvatar(
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
      throw new BadGatewayException(AVATAR_UPLOAD_FAILED);
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
