/**
 * First-SUPER_ADMIN bootstrap — run: `npm run auth:create-superadmin [-- --force]`
 *
 * "No public registration" plus "only a SUPER_ADMIN may create users" is a chicken-and-egg. A script
 * resolves it while keeping the public attack surface at zero — there is deliberately no bootstrap
 * endpoint.
 *
 * Replaces `scripts/seed-super-admin.ts` (deleted). Two things changed, both deliberate:
 *
 * 1. FULLY INTERACTIVE — no `SEED_SUPER_ADMIN_*` env bypass. The credential is typed at a masked
 *    prompt, so it never lands in a `.env` file, shell history, or a CI log. "Interactive-only" is a
 *    SECURITY PROPERTY, not a UX choice, so it is ENFORCED (a TTY check), not merely documented:
 *    `echo 'pw' | npm run auth:create-superadmin` exits 1 rather than quietly restoring the bypass.
 *
 * 2. It NEVER prompts for Department / Position. It resolve-or-creates the two SYSTEM-RESERVED
 *    option rows and assigns them. The old script let an operator seed the first SUPER_ADMIN into an
 *    ordinary, publicly-visible department — exactly the hole the reserved flag closes. This script
 *    is the ONLY writer of `isSystemReserved: true` in the entire codebase (one grep, one file).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠️  `--force` IS A BREAK-GLASS CREDENTIAL RESET, AND THIS REVERSES A DOCUMENTED DECISION.
 *
 * `seed-super-admin.ts` stated: "`lineUserId` is never touched, and neither is `mustChangePassword`
 * — a restore must not change a credential state." Its `update` block therefore set only
 * `{ deletedAt: null, isActive: true }`.
 *
 * This script's `update` block DOES change credential state: it overwrites `passwordHash`, clears the
 * forced-reset gate, and reassigns both options. The PO asked for this deliberately — the script's
 * identity moves from "idempotent seed" to "break-glass credential reset for the SUPER_ADMIN".
 * AFTER `--force`, THE PREVIOUS PASSWORD STOPS WORKING. That is the point: `--force` is a DESTRUCTIVE
 * operation on a live account, not a repair.
 *
 * The old reasoning is not wrong, it is out of scope: it was about a RESTORE (undeleting a row),
 * where silently resetting a credential would be a surprise. A break-glass tool is the one case where
 * resetting the credential IS the request. What that reversal must NOT drag along, and does not:
 *   - `role` is untouched in the `update` branch, AND an existing non-SUPER_ADMIN at that address is
 *     REFUSED outright (see `assertTargetIsSuperAdminOrAbsent`). Otherwise `--force` on a typo'd
 *     address would reset an ordinary ADMIN/STAFF user's password and flip their `isActive` /
 *     `deletedAt` — privilege-adjacent damage by typo.
 *   - `lineUserId` stays untouched. It is a notification address, not a credential.
 *   - The email burn + restore contract still holds: `upsert` on `email` returns the SAME row,
 *     preserving `id` and the whole `createdById` audit chain. Never a second row.
 *   - Without `--force`, behaviour is unchanged: refuse, write nothing, exit 0.
 * Mitigation: `--force` is interactive and TTY-gated, so it cannot fire from a pipeline, and the
 * reset path logs a line visibly distinct from the create path.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Reads no `SEED_SUPER_ADMIN_*` variable. Still needs `DATABASE_URL` (via `dotenv/config`), which is
 * a connection string, not a credential bypass. The password, its length and its digest are NEVER
 * logged — the final line carries `id=` and `email=` only.
 */
import 'dotenv/config';
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, SystemRole } from '@prisma/client';
import { PasswordService } from '../src/auth/password.service';

const logger = new Logger('CreateSuperAdmin');

/** The existing policy threshold, spelled the same as `seed-super-admin.ts` did. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The two SYSTEM-RESERVED option rows this script owns. Exported so the spec and any future reader
 * bind to ONE spelling: the rows are resolved BY NAME, so a divergent literal would create a second
 * reserved row rather than finding the first.
 *
 * (Resolving by name is a `WHERE name = $1` lookup in an offline script — NOT an authorization
 * expression. No name comparison ever decides privilege; the `isSystemReserved` FLAG is the boundary
 * and `SystemUser.role` is the only thing that grants anything.)
 */
export const RESERVED_DEPARTMENT_NAME = 'ผู้พัฒนาระบบ (System Developer)';
export const RESERVED_PERSONNEL_ROLE_NAME =
  'ผู้ดูแลระบบระดับสูง (System Administrator)';

/** Max re-prompts per field, so a non-interactive edge case cannot spin forever. */
const MAX_ATTEMPTS = 3;

// ─────────────────────────────── prompting ───────────────────────────────

/**
 * A `Writable` that can be muted mid-stream.
 *
 * This is why the masking works, and why it is NOT the `rl._writeToOutput` override that circulates
 * on Stack Overflow: that is a private API which has broken across Node majors. `readline` writes the
 * echo of each keystroke to its `output` stream, so handing it a stream that drops writes while muted
 * suppresses the echo through the PUBLIC interface only.
 */
export class MutableOutput extends Writable {
  muted = false;

  _write(
    chunk: any,
    encoding: BufferEncoding,
    cb: (error?: Error | null) => void,
  ): void {
    if (!this.muted) process.stdout.write(chunk as Buffer, encoding);
    cb();
  }
}

/** The seam the spec mocks: everything interactive goes through this. */
export interface Prompter {
  ask(question: string): Promise<string>;
  askMasked(question: string): Promise<string>;
  close(): void;
}

export function createPrompter(): Prompter {
  const output = new MutableOutput();
  // `terminal: true` is REQUIRED for readline to handle keystrokes (and thus to echo them through
  // `output`) at all. Without it there is nothing to mute.
  const rl: Interface = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  return {
    ask,
    askMasked: async (question: string): Promise<string> => {
      const pending = ask(question); // the PROMPT prints first...
      output.muted = true; // ...then mute, so the typed characters never echo
      try {
        return await pending;
      } finally {
        output.muted = false;
        process.stdout.write('\n'); // the Enter keypress was swallowed while muted
      }
    },
    close: () => rl.close(),
  };
}

// ─────────────────────────────── validation ───────────────────────────────

/**
 * Normalise exactly as `normaliseEmail` / `seed-super-admin.ts:78` did, so the address this script
 * writes is the address `AuthService` will later look up.
 */
export const normalise = (value: string): string => value.trim().toLowerCase();

/** Never reports the password's VALUE or its actual LENGTH — only the policy threshold. */
export function validatePassword(password: string): string | null {
  return password.length < MIN_PASSWORD_LENGTH
    ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    : null;
}

export function validateRequired(value: string, label: string): string | null {
  return value.trim() === '' ? `${label} must not be empty.` : null;
}

/**
 * Prompt until `validate` passes or the attempt cap is hit. An interactive tool must not make the
 * operator restart the whole run over a typo.
 */
async function promptUntilValid(
  prompt: () => Promise<string>,
  validate: (value: string) => string | null,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const value = await prompt();
    const error = validate(value);
    if (!error) return value;
    logger.error(error);
  }
  throw new Error(`Too many invalid attempts (${MAX_ATTEMPTS}). Aborting.`);
}

export interface Credentials {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * The five prompts, in order. Department / Position are deliberately absent — this script owns the
 * reserved rows and assigns them unconditionally.
 *
 * The confirm-password prompt is an ADDITION to the original four-prompt list, justified by the
 * masking: a typo in a masked field is invisible, and the result would be a SUPER_ADMIN credential
 * that nobody knows. One prompt, universal convention for masked entry.
 */
export async function collectCredentials(
  prompter: Prompter,
): Promise<Credentials> {
  const email = normalise(
    await promptUntilValid(
      () => prompter.ask('Email:      '),
      (v) => validateRequired(v, 'Email'),
    ),
  );

  const password = await promptUntilValid(
    async () => {
      const first = await prompter.askMasked('Password:   ');
      const problem = validatePassword(first);
      if (problem) return first; // let promptUntilValid report it and re-prompt
      const confirm = await prompter.askMasked('Confirm:    ');
      // Never log the confirm's value or whether it was empty — only that they differ.
      return first === confirm ? first : '';
    },
    (v) =>
      v === ''
        ? 'Passwords did not match (or were empty). Try again.'
        : validatePassword(v),
  );

  const firstName = (
    await promptUntilValid(
      () => prompter.ask('First name: '),
      (v) => validateRequired(v, 'First name'),
    )
  ).trim();

  const lastName = (
    await promptUntilValid(
      () => prompter.ask('Last name:  '),
      (v) => validateRequired(v, 'Last name'),
    )
  ).trim();

  return { email, password, firstName, lastName };
}

// ─────────────────────────── reserved option rows ───────────────────────────

/**
 * Resolve the ACTIVE, RESERVED option by name, creating it (flag set) if absent. Returns its id.
 *
 * The `isSystemReserved: true` in the PROBE is deliberate and is not redundant: if an ADMIN somehow
 * owns an active NON-reserved row of that name, we must not silently adopt it as the reserved row —
 * that is a privilege-relevant confusion. The `create` then hits the partial unique index
 * (`WHERE deletedAt IS NULL`) and raises P2002, which we translate into an actionable operator
 * message instead of an opaque Prisma dump.
 *
 * `deletedAt: null` matches that same partial index: a soft-deleted name is reusable, so only an
 * ACTIVE row counts as "already there".
 *
 * The two branches are spelled out rather than sharing a `delegate` variable, exactly as the old
 * script explained: `Department` and `PersonnelRole` have byte-identical but heavily overloaded
 * Prisma delegates, and a union of the two is not callable in TypeScript (`OptionsService` pays for
 * the same fact with a hand-written interface — overkill for a script).
 */
export async function resolveOrCreateReservedDepartment(
  prisma: PrismaClient,
  name: string = RESERVED_DEPARTMENT_NAME,
): Promise<number> {
  const existing = await prisma.department.findFirst({
    where: { name, deletedAt: null, isSystemReserved: true },
    select: { id: true },
  });
  if (existing) return existing.id;

  try {
    const created = await prisma.department.create({
      data: { name, isSystemReserved: true },
      select: { id: true },
    });
    logger.log(`Created reserved department option. id=${created.id}`);
    return created.id;
  } catch (error) {
    throw mapReservedOptionConflict(error, 'department', name);
  }
}

export async function resolveOrCreateReservedPersonnelRole(
  prisma: PrismaClient,
  name: string = RESERVED_PERSONNEL_ROLE_NAME,
): Promise<number> {
  const existing = await prisma.personnelRole.findFirst({
    where: { name, deletedAt: null, isSystemReserved: true },
    select: { id: true },
  });
  if (existing) return existing.id;

  try {
    const created = await prisma.personnelRole.create({
      data: { name, isSystemReserved: true },
      select: { id: true },
    });
    logger.log(`Created reserved personnelRole option. id=${created.id}`);
    return created.id;
  } catch (error) {
    throw mapReservedOptionConflict(error, 'personnelRole', name);
  }
}

/** A P2002 here means an ORDINARY active row already holds the reserved name. Say so, actionably. */
function mapReservedOptionConflict(
  error: unknown,
  model: string,
  name: string,
): Error {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    return new Error(
      `An ordinary (non-reserved) ${model} option named '${name}' already exists. ` +
        `Rename or soft-delete it, then re-run this script.`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ─────────────────────────────── the write ───────────────────────────────

export const NOT_A_SUPER_ADMIN_MESSAGE =
  'That email belongs to an existing non-SUPER_ADMIN user. Refusing to touch it: ' +
  '--force would reset their password and reactivate their account. Use a different address.';

/**
 * Refuse when the address belongs to an existing user who is NOT a SUPER_ADMIN.
 *
 * Necessary because `role` is absent from the `upsert`'s `update` block, which prevents a silent
 * PROMOTION but does not prevent the damage: without this check, `--force` on a typo'd address would
 * blindly reset an ordinary ADMIN/STAFF user's `passwordHash`, clear their forced-reset gate, and
 * flip `isActive` / `deletedAt`. Absence from `update` is necessary but NOT sufficient.
 *
 * Deliberately looks past `deletedAt`: a soft-deleted ADMIN at that address is still that ADMIN's
 * row (the email burn is permanent, by design), and `--force` would resurrect it.
 */
export async function assertTargetIsSuperAdminOrAbsent(
  prisma: PrismaClient,
  email: string,
): Promise<void> {
  const existing = await prisma.systemUser.findUnique({
    where: { email },
    select: { role: true },
  });
  if (existing && existing.role !== SystemRole.SUPER_ADMIN) {
    throw new Error(NOT_A_SUPER_ADMIN_MESSAGE);
  }
}

export interface RunOptions {
  force: boolean;
}

/**
 * The DB half, split from the prompting so the spec can drive it without a terminal.
 * Returns `null` when it refused (idempotent, non-error).
 */
export async function createSuperAdmin(
  prisma: PrismaClient,
  credentials: Credentials,
  opts: RunOptions,
): Promise<{ id: string; email: string; reset: boolean } | null> {
  // The `deletedAt: null` filter is load-bearing: a soft-deleted SUPER_ADMIN grants nobody access,
  // so counting one would let a deleted row permanently lock the operator out of re-running — the
  // exact scenario this script exists to rescue. It deliberately does NOT filter `isActive`: a
  // *suspended* super admin still exists and is one flag-flip from working, so refuse and let the
  // operator reactivate them.
  const existing = await prisma.systemUser.count({
    where: { role: SystemRole.SUPER_ADMIN, deletedAt: null },
  });

  if (existing > 0 && !opts.force) {
    logger.log(
      `A SUPER_ADMIN already exists (${existing} active). Refusing. Pass --force to reset its credentials.`,
    );
    return null; // idempotent, non-error
  }

  await assertTargetIsSuperAdminOrAbsent(prisma, credentials.email);

  const passwordHash = await new PasswordService().hash(credentials.password);

  // Resolve-or-create both reserved rows, so the script stays standalone and order-independent — it
  // must not require `options:seed` to have run first. NOT an `upsert`-on-name: active-name
  // uniqueness is a PARTIAL index (`WHERE deletedAt IS NULL`), which upsert cannot express.
  const personnelRoleId = await resolveOrCreateReservedPersonnelRole(prisma);
  const departmentId = await resolveOrCreateReservedDepartment(prisma);

  const isReset = existing > 0;

  const user = await prisma.systemUser.upsert({
    where: { email: credentials.email },
    create: {
      email: credentials.email,
      passwordHash,
      firstName: credentials.firstName,
      lastName: credentials.lastName,
      role: SystemRole.SUPER_ADMIN,
      personnelRoleId,
      departmentId,
      // EXPLICIT: the model default is `true`. Without this a FRESH database would brick the new
      // super admin behind a forced-reset screen demanding a temp password nobody was ever issued.
      // They just chose this password interactively — there is nothing to reset.
      mustChangePassword: false,
      isActive: true,
      createdById: null,
    },
    // BREAK-GLASS RESET — see the header. Exactly these six fields, explicitly. `role` and
    // `lineUserId` are ABSENT on purpose: no promotion-by-typo, and a notification address is not a
    // credential. The SAME row returns, preserving `id` and the `createdById` audit chain.
    update: {
      passwordHash,
      departmentId,
      personnelRoleId,
      mustChangePassword: false,
      isActive: true,
      deletedAt: null,
    },
    select: { id: true, email: true },
  });

  return { ...user, reset: isReset };
}

// ─────────────────────────────── the CLI shell ───────────────────────────────

/**
 * TTY gate. "Interactive-only" is a security property (no secret in `.env`, none in shell history,
 * none in a CI log), so it is enforced rather than documented. Without this,
 * `echo 'hunter2...' | npm run auth:create-superadmin` quietly restores the bypass this script was
 * written to remove.
 */
export function assertInteractive(
  stdin: { isTTY?: boolean } = process.stdin,
): void {
  if (!stdin.isTTY) {
    throw new Error(
      'This script is interactive and must be run from a terminal. ' +
        'Piped or redirected stdin is refused: a password must never come from a pipe, a file, or CI.',
    );
  }
}

export async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  try {
    assertInteractive();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const prompter = createPrompter();
  let credentials: Credentials;
  try {
    credentials = await collectCredentials(prompter);
  } finally {
    prompter.close();
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const result = await createSuperAdmin(prisma, credentials, { force });
    if (!result) return;

    // Visibly distinct from the create path, so the audit trail shows which happened.
    logger.log(
      result.reset
        ? `SUPER_ADMIN credentials reset (--force). id=${result.id} email=${result.email}`
        : `Created SUPER_ADMIN. id=${result.id} email=${result.email}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Guarded so the spec can import this module without the CLI firing on require.
if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error(
      `Failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
