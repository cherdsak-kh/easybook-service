import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(() => {
    service = new PasswordService();
  });

  it('hashes to an argon2id digest, never plaintext (AC-7)', async () => {
    const digest = await service.hash('correct horse battery staple');

    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(digest).not.toContain('correct horse battery staple');
    expect(digest).toContain('m=19456,t=2,p=1');
  });

  it('produces different digests for two users with the same password (per-hash salt, AC-7)', async () => {
    const [a, b] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);

    expect(a).not.toEqual(b);
    await expect(service.verify(a, 'same-password')).resolves.toBe(true);
    await expect(service.verify(b, 'same-password')).resolves.toBe(true);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const digest = await service.hash('s3cret-passphrase');

    await expect(service.verify(digest, 's3cret-passphrase')).resolves.toBe(
      true,
    );
    await expect(service.verify(digest, 's3cret-passphras')).resolves.toBe(
      false,
    );
    await expect(service.verify(digest, '')).resolves.toBe(false);
  });

  it('returns false on a malformed digest rather than throwing', async () => {
    await expect(service.verify('not-a-digest', 'anything')).resolves.toBe(
      false,
    );
    await expect(service.verify('', 'anything')).resolves.toBe(false);
  });

  it('exposes a stable dummy hash that verifies false for any password', async () => {
    const dummy = await service.dummyHash();

    expect(dummy.startsWith('$argon2id$')).toBe(true);
    // Stable across calls — computed once at construction.
    await expect(service.dummyHash()).resolves.toBe(dummy);
    await expect(service.verify(dummy, 'any password at all')).resolves.toBe(
      false,
    );
  });

  it('gives two service instances different dummy hashes (random input)', async () => {
    const other = new PasswordService();
    await expect(other.dummyHash()).resolves.not.toBe(
      await service.dummyHash(),
    );
  });

  describe('generateTemporaryPassword', () => {
    it('is 16 chars from the unambiguous alphabet — no 0/O/1/l/I to misread', () => {
      for (let i = 0; i < 200; i += 1) {
        const temp = service.generateTemporaryPassword();
        expect(temp).toHaveLength(16);
        // The alphabet, spelled out independently of the implementation's constant.
        expect(temp).toMatch(
          /^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{16}$/,
        );
        expect(temp).not.toMatch(/[0O1lI]/);
      }
    });

    it('satisfies the >= 12 char rule the change-password endpoint enforces', () => {
      expect(service.generateTemporaryPassword().length).toBeGreaterThanOrEqual(
        12,
      );
    });

    it('never repeats — 500 draws are distinct (a fixed or low-entropy temp password is a breach)', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 500; i += 1)
        seen.add(service.generateTemporaryPassword());
      expect(seen.size).toBe(500);
    });

    it('hashes to an argon2id digest that verifies, and the digest never contains the plaintext', async () => {
      const temp = service.generateTemporaryPassword();
      const digest = await service.hash(temp);

      expect(digest).not.toContain(temp);
      await expect(service.verify(digest, temp)).resolves.toBe(true);
    });
  });
});
