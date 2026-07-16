import { BadRequestException } from '@nestjs/common';
import {
  AVATAR_REQUIRED,
  AVATAR_TYPE_UNSUPPORTED,
} from '../storage/storage.errors';
import { R2StorageService } from '../storage/r2-storage.service';
import { SystemUsersService } from '../system-users/system-users.service';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MULTER_SIZE_LIMIT,
  AvatarUploadService,
} from './avatar-upload.service';
import type { AuthenticatedSystemUser } from './auth.types';

const BASE = 'https://pub-abc123.r2.dev';

const pngBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
const jpegBytes = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

const fileOf = (over: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'me.png',
    mimetype: 'image/png',
    buffer: pngBytes(),
    size: 40,
    ...over,
  }) as Express.Multer.File;

const userOf = (profilePictureUrl: string | null = null) =>
  ({ id: 'u-1', profilePictureUrl }) as AuthenticatedSystemUser;

describe('AvatarUploadService', () => {
  let service: AvatarUploadService;

  const putAvatar = jest.fn();
  const deleteObject = jest.fn();
  const buildAvatarKey = jest.fn();
  const publicUrlFor = jest.fn();
  const publicBaseUrl = jest.fn();
  const setOwnAvatar = jest.fn();

  const storage = {
    putAvatar,
    deleteObject,
    buildAvatarKey,
    publicUrlFor,
    publicBaseUrl,
  } as unknown as R2StorageService;
  const systemUsers = { setOwnAvatar } as unknown as SystemUsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks clears CALLS, not implementations — a mockRejectedValue set by one test would
    // otherwise leak into every test after it.
    putAvatar.mockResolvedValue(undefined);
    buildAvatarKey.mockReturnValue('avatars/u-1/deadbeef.png');
    publicUrlFor.mockImplementation((k: string) => `${BASE}/${k}`);
    publicBaseUrl.mockReturnValue(BASE);
    setOwnAvatar.mockResolvedValue({ id: 'u-1' });
    deleteObject.mockResolvedValue(true);
    service = new AvatarUploadService(storage, systemUsers);
  });

  it('2 MiB is the advertised limit', () => {
    expect(AVATAR_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('the multer limit is AVATAR_MAX_BYTES + 1, because busboy s limit is EXCLUSIVE', () => {
    // busboy emits 'limit' when fileSize === limits.fileSize, so handing it 2 MiB would reject a
    // file of exactly 2 MiB and make the real ceiling 2 MiB - 1 — contradicting the error message
    // and the client-side pre-check. Pinned so nobody "tidies" the +1 away.
    expect(AVATAR_MULTER_SIZE_LIMIT).toBe(AVATAR_MAX_BYTES + 1);
  });

  // ───────────────────────── validation (AC-B13) ─────────────────────────

  it('uploads a valid PNG and writes the resulting https URL', async () => {
    await service.replaceAvatar(userOf(), fileOf());

    expect(putAvatar).toHaveBeenCalledWith(
      'avatars/u-1/deadbeef.png',
      expect.any(Buffer),
      'image/png',
    );
    expect(setOwnAvatar).toHaveBeenCalledWith(
      'u-1',
      `${BASE}/avatars/u-1/deadbeef.png`,
    );
  });

  it('AC-B13 — an EXE renamed .png and DECLARED image/png is a 400: the bytes are the control', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x90)]);
    const file = fileOf({
      mimetype: 'image/png',
      originalname: 'safe.png',
      buffer: exe,
    });

    await expect(service.replaceAvatar(userOf(), file)).rejects.toThrow(
      new BadRequestException(AVATAR_TYPE_UNSUPPORTED),
    );
    expect(putAvatar).not.toHaveBeenCalled();
    expect(setOwnAvatar).not.toHaveBeenCalled();
  });

  it('400s when the sniffed type DISAGREES with the declared one (real JPEG declared as PNG)', async () => {
    const file = fileOf({ mimetype: 'image/png', buffer: jpegBytes() });

    await expect(service.replaceAvatar(userOf(), file)).rejects.toThrow(
      new BadRequestException(AVATAR_TYPE_UNSUPPORTED),
    );
    expect(putAvatar).not.toHaveBeenCalled();
  });

  it('400s a declared MIME outside the allowlist, even when the bytes are a real image', async () => {
    const file = fileOf({ mimetype: 'image/gif', buffer: pngBytes() });

    await expect(service.replaceAvatar(userOf(), file)).rejects.toThrow(
      new BadRequestException(AVATAR_TYPE_UNSUPPORTED),
    );
  });

  it('400s an empty buffer', async () => {
    await expect(
      service.replaceAvatar(userOf(), fileOf({ buffer: Buffer.alloc(0) })),
    ).rejects.toThrow(new BadRequestException(AVATAR_REQUIRED));
  });

  it('derives the key extension and ContentType from the SNIFFED type, never from originalname', async () => {
    // A JPEG honestly declared, but with a misleading .png name and a traversal attempt.
    const file = fileOf({
      mimetype: 'image/jpeg',
      originalname: '../../../etc/passwd.png',
      buffer: jpegBytes(),
    });

    await service.replaceAvatar(userOf(), file);

    expect(buildAvatarKey).toHaveBeenCalledWith('u-1', 'image/jpeg');
    expect(putAvatar).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      'image/jpeg',
    );
    // originalname never reaches the key or the stored type.
    expect(JSON.stringify(putAvatar.mock.calls)).not.toContain('passwd');
  });

  // ───────────────────────── ordering / cleanup ─────────────────────────

  it('does NOT write the DB when the upload fails — no dead URL', async () => {
    putAvatar.mockRejectedValue(new Error('r2 down'));

    await expect(service.replaceAvatar(userOf(), fileOf())).rejects.toThrow(
      'r2 down',
    );
    expect(setOwnAvatar).not.toHaveBeenCalled();
  });

  it('deletes the just-uploaded object when the DB write fails — no orphan', async () => {
    setOwnAvatar.mockRejectedValue(new Error('db down'));

    await expect(service.replaceAvatar(userOf(), fileOf())).rejects.toThrow(
      'db down',
    );
    expect(deleteObject).toHaveBeenCalledWith('avatars/u-1/deadbeef.png');
  });

  it('best-effort deletes the PREVIOUS object on a successful replace', async () => {
    await service.replaceAvatar(
      userOf(`${BASE}/avatars/u-1/oldkey1234.jpg`),
      fileOf(),
    );

    expect(deleteObject).toHaveBeenCalledWith('avatars/u-1/oldkey1234.jpg');
  });

  it('never deletes when the old URL is OUTSIDE our bucket — you do not delete a stranger object', async () => {
    await service.replaceAvatar(
      userOf('https://evil.example.com/avatars/u-1/x.jpg'),
      fileOf(),
    );

    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('never deletes when the old URL is our base but NOT under avatars/', async () => {
    await service.replaceAvatar(
      userOf(`${BASE}/some/other/object.jpg`),
      fileOf(),
    );

    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('attempts no delete when there was no previous avatar', async () => {
    await service.replaceAvatar(userOf(null), fileOf());
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('still succeeds when the best-effort cleanup fails — cleanup never fails the request', async () => {
    deleteObject.mockResolvedValue(false);

    await expect(
      service.replaceAvatar(userOf(`${BASE}/avatars/u-1/old.jpg`), fileOf()),
    ).resolves.toEqual({ id: 'u-1' });
  });
});
