import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

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
}
