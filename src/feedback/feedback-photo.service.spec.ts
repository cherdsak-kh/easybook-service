import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppAccess } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { R2StorageService } from '../storage/r2-storage.service';
import { FeedbackPhotoService } from './feedback-photo.service';
import {
  FEEDBACK_PHOTO_MAX_BYTES,
  FEEDBACK_PHOTO_MULTER_SIZE_LIMIT,
  FEEDBACK_NOT_ALLOWED,
  FEEDBACK_PHOTO_REQUIRED,
  FEEDBACK_PHOTO_TYPE_UNSUPPORTED,
} from './feedback.constants';

const SUB = 'U0123456789abcdef0123456789abcdef';
const BASE = 'https://pub-abc123.r2.dev';
const KEY = 'feedback/0123456789abcdef0123456789abcdef.png';

const pngBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
const jpegBytes = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
/** "RIFF" …size… "WEBP" — a real image the sniffer recognises and this route must still refuse. */
const webpBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBP'),
    Buffer.alloc(32),
  ]);
/** `%PDF-1.7` — the `.jpg`-named PDF of AC-39. */
const pdfBytes = (): Buffer =>
  Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(32)]);

const fileOf = (over: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'broken-aircon.png',
    mimetype: 'image/png',
    buffer: pngBytes(),
    size: 40,
    ...over,
  }) as Express.Multer.File;

describe('FeedbackPhotoService', () => {
  let service: FeedbackPhotoService;

  const findFirst = jest.fn();
  /** Typed because the tests READ its arguments — a bare jest.fn() makes them `any`. */
  const putImage = jest.fn<Promise<void>, [string, Buffer, string]>();
  const buildFeedbackPhotoKey = jest.fn();
  const publicUrlFor = jest.fn();

  const prisma = { lineUser: { findFirst } } as unknown as PrismaService;
  const storage = {
    putImage,
    buildFeedbackPhotoKey,
    publicUrlFor,
  } as unknown as R2StorageService;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks clears CALLS, not implementations.
    findFirst.mockResolvedValue({
      id: 'clx_lineuser',
      access: AppAccess.ALLOWED,
    });
    putImage.mockResolvedValue(undefined);
    buildFeedbackPhotoKey.mockReturnValue(KEY);
    publicUrlFor.mockImplementation((k: string) => `${BASE}/${k}`);
    service = new FeedbackPhotoService(storage, prisma);
  });

  it('the multer limit is FEEDBACK_PHOTO_MAX_BYTES + 1, because busboy’s limit is EXCLUSIVE', () => {
    // busboy emits 'limit' when the byte count === limits.fileSize, so handing it 5 MiB would
    // reject a file of exactly 5 MiB and make the real ceiling 5 MiB − 1 — contradicting both the
    // error message and the client's pre-check (AC-20). Pinned so nobody "tidies" the +1 away.
    expect(FEEDBACK_PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(FEEDBACK_PHOTO_MULTER_SIZE_LIMIT).toBe(FEEDBACK_PHOTO_MAX_BYTES + 1);
  });

  // ───────────────────────── who (D-A6) ─────────────────────────

  it('🔴 refuses a caller who is not ALLOWED, before a single byte is stored', async () => {
    // Beyond AC-35's literal wording on purpose: this route writes 5 MB objects into a public-read
    // bucket, so leaving it open to any token-bearing follower makes it free storage.
    findFirst.mockResolvedValue({
      id: 'clx_lineuser',
      access: AppAccess.BLOCKED,
    });

    await expect(service.upload(SUB, fileOf())).rejects.toThrow(
      new ForbiddenException(FEEDBACK_NOT_ALLOWED),
    );
    expect(putImage).not.toHaveBeenCalled();
  });

  // ───────────────────────── the bytes (AC-39) ─────────────────────────

  it('stores a PNG under the feedback prefix and answers with its URL', async () => {
    const result = await service.upload(SUB, fileOf());

    expect(buildFeedbackPhotoKey).toHaveBeenCalledWith('image/png');
    expect(putImage).toHaveBeenCalledWith(KEY, expect.any(Buffer), 'image/png');
    expect(result).toEqual({ url: `${BASE}/${KEY}` });
  });

  it('🔴 derives the stored type from the BYTES, never from the filename', async () => {
    // A `.png`-named JPEG, declared `image/jpeg`: stored as JPEG, and `originalname` is ignored
    // entirely (attacker-controlled — the path-traversal / double-extension vector).
    await service.upload(
      SUB,
      fileOf({
        originalname: 'not-really.png',
        mimetype: 'image/jpeg',
        buffer: jpegBytes(),
      }),
    );

    expect(buildFeedbackPhotoKey).toHaveBeenCalledWith('image/jpeg');
    expect(putImage.mock.calls[0][2]).toBe('image/jpeg');
  });

  it('refuses a `.jpg`-named PDF — the sniff is the control, the declaration is not', async () => {
    await expect(
      service.upload(
        SUB,
        fileOf({
          originalname: 'invoice.jpg',
          mimetype: 'image/jpeg',
          buffer: pdfBytes(),
        }),
      ),
    ).rejects.toThrow(new BadRequestException(FEEDBACK_PHOTO_TYPE_UNSUPPORTED));
    expect(putImage).not.toHaveBeenCalled();
  });

  it('refuses a mismatched declaration even when both are image types', async () => {
    await expect(
      service.upload(
        SUB,
        fileOf({ mimetype: 'image/png', buffer: jpegBytes() }),
      ),
    ).rejects.toThrow(new BadRequestException(FEEDBACK_PHOTO_TYPE_UNSUPPORTED));
  });

  it('🔴 refuses WEBP, which the shared sniffer recognises and the avatar allowlist accepts', async () => {
    // D-A8: AC-39 is JPEG/PNG only and the client rejects webp before upload, so a server that
    // accepted it would be accepting something no screen can produce. `image-sniff.ts` is reused
    // UNCHANGED — only this module's allowlist is narrower.
    await expect(
      service.upload(
        SUB,
        fileOf({
          originalname: 'photo.webp',
          mimetype: 'image/webp',
          buffer: webpBytes(),
        }),
      ),
    ).rejects.toThrow(new BadRequestException(FEEDBACK_PHOTO_TYPE_UNSUPPORTED));
    expect(putImage).not.toHaveBeenCalled();
  });

  it('refuses an empty buffer', async () => {
    await expect(
      service.upload(SUB, fileOf({ buffer: Buffer.alloc(0) })),
    ).rejects.toThrow(new BadRequestException(FEEDBACK_PHOTO_REQUIRED));
  });
});
