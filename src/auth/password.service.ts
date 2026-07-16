import { randomBytes, randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Unambiguous alphabet: no `0`/`O`, no `1`/`l`/`I`. A temporary password is read off one screen and
 * typed into another by a human, so a glyph collision is a support ticket.
 */
const TEMP_PASSWORD_ALPHABET =
  'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** 16 chars over a 54-char alphabet ≈ 92 bits. Comfortably clears the ≥12 rule in §5.3. */
const TEMP_PASSWORD_LENGTH = 16;

/**
 * argon2id password hashing with OWASP-recommended parameters.
 *
 * `PasswordService` is the seam: if the native build ever fails on a dev box, D-2 permits swapping
 * in bcrypt here and nothing outside this file changes.
 */
@Injectable()
export class PasswordService {
  private static readonly OPTS: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  };

  /**
   * A digest of a random string, computed once at construction.
   *
   * `AuthService` verifies against it whenever the account does not exist, is soft-deleted, or is
   * suspended, so all four login-failure branches burn equivalent CPU. Without it, a nonexistent
   * account would answer measurably faster than a real one with a wrong password — an
   * account-existence oracle.
   */
  private readonly dummyHashPromise: Promise<string>;

  constructor() {
    this.dummyHashPromise = this.hash(randomBytes(32).toString('hex'));
    // Keep a rejection from surfacing as an unhandled rejection before the first login awaits it.
    void this.dummyHashPromise.catch(() => undefined);
  }

  /** → `"$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>"`. Salt is random per hash (AC-7). */
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, PasswordService.OPTS);
  }

  /** Returns `false` on a malformed digest rather than throwing. */
  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(digest, plain);
    } catch {
      return false;
    }
  }

  dummyHash(): Promise<string> {
    return this.dummyHashPromise;
  }

  /**
   * A single-use temporary password, issued by `POST /system-users` and
   * `POST /system-users/:id/reset-password`.
   *
   * `crypto.randomInt` per character — rejection-sampled by Node, so the draw is unbiased. NEVER
   * `Math.random`: it is a non-cryptographic PRNG whose internal state is recoverable from a handful
   * of outputs, which would make every subsequently issued temp password predictable.
   *
   * The caller hashes this immediately and returns the plaintext exactly once (AC-B7). It satisfies
   * the §5.3 new-password rules, so the recipient could technically keep it — they cannot, because
   * `mustChangePassword` forces the change regardless.
   */
  generateTemporaryPassword(): string {
    let out = '';
    for (let i = 0; i < TEMP_PASSWORD_LENGTH; i += 1) {
      out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
    }
    return out;
  }
}
