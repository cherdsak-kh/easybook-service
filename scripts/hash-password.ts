/**
 * Standalone argon2id password hasher — run: `npm run auth:hash-password -- '<password>'`
 *
 * Prints ONLY the digest to stdout, so it pipes and copies cleanly:
 *
 *     $ npm run auth:hash-password -- 'correct horse battery staple'
 *     $argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>
 *
 * For debugging and for hand-seeding a `SystemUser.passwordHash` straight into the DB (psql, Prisma
 * Studio) without an admin session. It reuses `PasswordService` rather than calling argon2 itself —
 * that is what guarantees the output is byte-compatible with what the auth system writes and what
 * `AuthService` will later verify. Never re-implement the options here; the seam is `PasswordService`.
 *
 * A SCRIPT, NOT AN ENDPOINT — deliberately. `POST /api/v1/utils/hash-password`, gated on
 * `NODE_ENV !== 'production'`, was proposed and REJECTED. Do not re-litigate it:
 *   - `seed-super-admin.ts` already records the project's stance: a script "keeps the public attack
 *     surface at zero — there is deliberately no bootstrap endpoint." No route in this repo accepts a
 *     raw password for provisioning, and this utility is not the precedent that changes that.
 *   - The `NODE_ENV` gate FAILS OPEN: unset, `'prod'`, or a trailing space all leave the route live,
 *     and `validateEnv` never requires `NODE_ENV` — so the gate is a comment, not a control.
 *   - An unauthenticated argon2id call (`memoryCost: 19456`, `timeCost: 2`) is a DoS amplifier: one
 *     cheap HTTP POST buys 19 MiB and two passes of CPU.
 *   - A plaintext password in an HTTP body reaches proxy and APM logs. CLAUDE.md forbids a
 *     request/response body logger for exactly this reason; an endpoint would route credentials past
 *     that rule via infrastructure the app does not control.
 * A script has no network surface, so the entire security question disappears rather than being
 * mitigated. See `claude_planning/20260717_1200_hash_password_utility/`.
 *
 * SHELL HISTORY CAVEAT: the password arrives as an argv, so it lands in `.bash_history` /
 * PSReadLine's `ConsoleHost_history.txt`, and is visible in `ps` while the process runs. Prefix the
 * command with a space (bash, with `HISTCONTROL=ignorespace`) or clear the entry afterward. Treat any
 * password passed to this utility as burned — which is fine for the debug/seed values it exists for.
 *
 * The plaintext is never logged, not its value and not its length (same discipline as
 * `seed-super-admin.ts`). The digest on stdout is the only intended output.
 *
 * No Prisma, no Redis, no `.env`: this is a pure hash utility. `seed-super-admin.ts` opens a DB
 * connection because it writes a user; there is nothing to write here.
 */
import { Logger } from '@nestjs/common';
import { PasswordService } from '../src/auth/password.service';

const logger = new Logger('HashPassword');

const USAGE = `Usage: npm run auth:hash-password -- '<password>'`;

/**
 * Hash the password taken from the argv tail (`process.argv.slice(2)`).
 *
 * Rejects on anything other than exactly one argument. The "more than one" case is not pedantry: an
 * unquoted password with spaces arrives as several argv entries, and silently hashing only the first
 * word would emit a valid-looking digest for the WRONG password — a bug the operator finds later, at
 * a login prompt. Neither the arguments nor their count appear in the message.
 *
 * Exported for the unit spec; `main` is the CLI shell around it.
 */
export async function hashPasswordFromArgv(
  args: readonly string[],
): Promise<string> {
  if (args.length === 0 || args[0] === '') {
    throw new Error(`No password given. ${USAGE}`);
  }
  if (args.length > 1) {
    throw new Error(
      `Expected exactly one argument — quote the password if it contains spaces. ${USAGE}`,
    );
  }
  return new PasswordService().hash(args[0]);
}

/** Exported for the unit spec. Sets `process.exitCode`, never `process.exit`, so stdout can flush. */
export async function main(): Promise<void> {
  let digest: string;
  try {
    digest = await hashPasswordFromArgv(process.argv.slice(2));
  } catch (error: unknown) {
    // Logger.error goes to stderr, keeping stdout clean for consumers that pipe this script.
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  // Raw stdout, NOT the Logger: a timestamped `[Nest] LOG` prefix would break `... | xclip`.
  process.stdout.write(`${digest}\n`);
}

// Guarded so the spec can import this module without the CLI firing on require.
if (require.main === module) {
  void main();
}
