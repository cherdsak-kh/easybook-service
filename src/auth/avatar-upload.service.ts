import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  AVATAR_REQUIRED,
  AVATAR_TYPE_UNSUPPORTED,
} from '../storage/storage.errors';
import { isAvatarImageType, sniffImageType } from '../storage/image-sniff';
import { R2StorageService } from '../storage/r2-storage.service';
import { SystemUserResponseDto } from '../system-users/dto/system-user-response.dto';
import { SystemUsersService } from '../system-users/system-users.service';
import type { AuthenticatedSystemUser } from './auth.types';

/** 2 MiB — the largest avatar we accept. The number the error message and the UI both quote. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What we actually hand multer: `AVATAR_MAX_BYTES + 1`.
 *
 * NOT a fudge — busboy's limit is EXCLUSIVE. It emits `'limit'` when the byte count `===`
 * `limits.fileSize` (`busboy/lib/types/multipart.js`: `if (fileSize === fileSizeLimit) … emit('limit')`),
 * so passing 2 MiB would reject a file of exactly 2 MiB and make the real ceiling 2 MiB − 1. That
 * would contradict our own `AVATAR_TOO_LARGE` message ("2 MB or smaller") and the client-side
 * pre-check (`<= 2 MB`), which would pass a 2 MiB file straight into a server 400.
 *
 * With +1: exactly 2 MiB is accepted, 2 MiB + 1 aborts the stream and becomes a 400 (AC-B13). The
 * process still never buffers more than ~2 MiB + 1 byte.
 */
export const AVATAR_MULTER_SIZE_LIMIT = AVATAR_MAX_BYTES + 1;

/**
 * Orchestrates `POST /auth/system/me/avatar`: validate → put → DB write → best-effort cleanup.
 *
 * Separate from `R2StorageService` (the SDK seam) and from `SystemUsersService` (which owns the DB
 * write) because it is the only thing that needs to know about BOTH.
 */
@Injectable()
export class AvatarUploadService {
  private readonly logger = new Logger(AvatarUploadService.name);

  constructor(
    private readonly storage: R2StorageService,
    private readonly systemUsers: SystemUsersService,
  ) {}

  /**
   * Validation, in order, all mandatory:
   *  1. Size — already enforced upstream by multer (`limits.fileSize`), whose `MulterError` the
   *     route's filter maps to 400. An empty buffer is still rejected here.
   *  2. Declared MIME — a cheap first filter, NOT a control: `file.mimetype` is client-supplied.
   *  3. Magic bytes — THE control. A sniffed type that disagrees with the declared one is a 400.
   *
   * `originalname` is ignored entirely: it is attacker-controlled and is the classic path-traversal
   * / double-extension vector. The stored ContentType and the key's extension come from the SNIFFED
   * type only.
   */
  private sniffOrThrow(file: Express.Multer.File) {
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException(AVATAR_REQUIRED);
    }
    // 2. Declared MIME allowlist (first filter, not evidence).
    if (!isAvatarImageType(file.mimetype)) {
      throw new BadRequestException(AVATAR_TYPE_UNSUPPORTED);
    }
    // 3. Magic bytes (the control) — and they must AGREE with the declaration.
    const sniffed = sniffImageType(file.buffer);
    if (!sniffed || sniffed !== file.mimetype) {
      throw new BadRequestException(AVATAR_TYPE_UNSUPPORTED);
    }
    return sniffed;
  }

  /**
   * Ordered so no failure mode leaves an orphan or a dead URL:
   *
   *  1. `PutObject` the new key. Fail → 502, DB untouched, no orphan.
   *  2. DB write. Fail → best-effort delete of the NEW key, then rethrow (no orphan).
   *  3. On success, best-effort delete of the PREVIOUS object — **only if** the old URL starts with
   *     `${R2_PUBLIC_BASE_URL}/avatars/`. That guard is load-bearing: an admin may have set an
   *     arbitrary external URL via `PATCH /system-users/:id`, and deriving a delete target from an
   *     arbitrary URL is how you delete someone else's object. Cleanup failure is a warn, never a
   *     failed request.
   */
  async replaceAvatar(
    user: AuthenticatedSystemUser,
    file: Express.Multer.File,
  ): Promise<SystemUserResponseDto> {
    const contentType = this.sniffOrThrow(file);
    const key = this.storage.buildAvatarKey(user.id, contentType);

    await this.storage.putAvatar(key, file.buffer, contentType); // 1

    let updated: SystemUserResponseDto;
    try {
      updated = await this.systemUsers.setOwnAvatar(
        user.id,
        this.storage.publicUrlFor(key),
      ); // 2
    } catch (error) {
      await this.storage.deleteObject(key); // never leave the object we just wrote orphaned
      throw error;
    }

    await this.deletePreviousAvatar(user.profilePictureUrl); // 3
    this.logger.log(`Avatar updated. id=${user.id}`);
    return updated;
  }

  /** Best-effort, prefix-guarded. Never throws. */
  private async deletePreviousAvatar(
    previousUrl: string | null,
  ): Promise<void> {
    if (!previousUrl) return;
    const base = this.storage.publicBaseUrl();
    if (!base) return;

    const prefix = `${base}/avatars/`;
    if (!previousUrl.startsWith(prefix)) return; // NOT ours — never derive a delete from a foreign URL

    await this.storage.deleteObject(previousUrl.slice(`${base}/`.length));
  }
}
