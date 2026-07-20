/**
 * Spec for `scripts/hash-password.ts`.
 *
 * WHY IT LIVES HERE AND NOT NEXT TO THE SCRIPT: the root jest config pins `rootDir: src`, so a spec
 * under `scripts/` is never discovered — it would silently never run, which is worse than no test.
 * The alternative (widening jest's `roots` to include `scripts/`) changes test discovery for the
 * whole repo to accommodate one file. So the spec sits in the domain the script belongs to: it is a
 * thin CLI over `src/auth/password.service.ts`, and its whole contract is "the digest is what the
 * auth system would have written". `password.service.spec.ts` is its neighbour on purpose.
 */
import { Logger } from '@nestjs/common';
import { PasswordService } from './password.service';
import { hashPasswordFromArgv, main } from '../../scripts/hash-password';

/** The exact prefix `SystemUser.passwordHash` carries — `PasswordService.OPTS` spelled out. */
const ARGON2ID_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';

describe('scripts/hash-password', () => {
  describe('hashPasswordFromArgv', () => {
    it('emits a digest that verifies against the original password', async () => {
      const digest = await hashPasswordFromArgv(['test-password-123']);

      await expect(
        new PasswordService().verify(digest, 'test-password-123'),
      ).resolves.toBe(true);
    });

    it('emits the argon2id format the DB expects, and never the plaintext', async () => {
      const digest = await hashPasswordFromArgv(['test-password-123']);

      expect(digest.startsWith(ARGON2ID_PREFIX)).toBe(true);
      expect(digest).not.toContain('test-password-123');
    });

    it('salts randomly — two hashes of the same password differ, and both verify', async () => {
      const [a, b] = await Promise.all([
        hashPasswordFromArgv(['same-password']),
        hashPasswordFromArgv(['same-password']),
      ]);

      expect(a).not.toEqual(b);
      const service = new PasswordService();
      await expect(service.verify(a, 'same-password')).resolves.toBe(true);
      await expect(service.verify(b, 'same-password')).resolves.toBe(true);
    });

    it('rejects a wrong password against the emitted digest', async () => {
      const digest = await hashPasswordFromArgv(['test-password-123']);

      await expect(
        new PasswordService().verify(digest, 'test-password-124'),
      ).resolves.toBe(false);
    });

    it('errors when no password is given', async () => {
      await expect(hashPasswordFromArgv([])).rejects.toThrow(
        /No password given/,
      );
    });

    it('errors on an empty-string password rather than hashing it', async () => {
      await expect(hashPasswordFromArgv([''])).rejects.toThrow(
        /No password given/,
      );
    });

    it('errors on an unquoted multi-word password instead of hashing only the first word', async () => {
      await expect(
        hashPasswordFromArgv(['correct', 'horse', 'battery']),
      ).rejects.toThrow(/quote the password/);
    });
  });

  describe('main', () => {
    const realArgv = process.argv;
    const realExitCode = process.exitCode;
    let writes: string[];

    beforeEach(() => {
      writes = [];
      // Capture rather than assert on `mock.calls`: `process.stdout.write` is overloaded, so its
      // call tuple types as `any` and trips no-unsafe-member-access.
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
      process.argv = realArgv;
      // Load-bearing: leaving exitCode = 1 behind would fail the whole jest run.
      process.exitCode = realExitCode;
    });

    it('writes ONLY the digest to stdout, so the output is pipeable', async () => {
      process.argv = ['node', 'hash-password.ts', 'test-password-123'];

      await main();

      expect(writes).toHaveLength(1);
      const written = writes[0];
      expect(written.endsWith('\n')).toBe(true);
      expect(written.startsWith(ARGON2ID_PREFIX)).toBe(true);
      await expect(
        new PasswordService().verify(written.trim(), 'test-password-123'),
      ).resolves.toBe(true);
      expect(process.exitCode).toBe(realExitCode);
    });

    it('exits non-zero and writes nothing to stdout when no password is given', async () => {
      process.argv = ['node', 'hash-password.ts'];
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await main();

      expect(process.exitCode).toBe(1);
      expect(writes).toHaveLength(0);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('No password given'),
      );
    });
  });
});
