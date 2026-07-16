/**
 * First-SUPER_ADMIN seed — run: `npm run auth:seed-superadmin [-- --force]`
 *
 * "No public registration" plus "only a SUPER_ADMIN may create users" is a chicken-and-egg. A
 * script resolves it while keeping the public attack surface at zero — there is deliberately no
 * bootstrap endpoint.
 *
 * Requires in .env: SEED_SUPER_ADMIN_EMAIL, SEED_SUPER_ADMIN_PASSWORD (>= 12 chars).
 * Optional:         SEED_SUPER_ADMIN_POSITION, SEED_SUPER_ADMIN_DEPARTMENT.
 *
 * NOTE — these two vars KEEP their names but changed MEANING on 2026-07-16: they are no longer
 * free-text column values but the NAME OF THE OPTION to resolve-or-create in `personnel_roles` /
 * `departments` (SystemUser.position/department became FKs; DD-7 superseded).
 *
 * Idempotent: refuses when a non-deleted SUPER_ADMIN already exists (unless --force), and restores
 * a soft-deleted row rather than creating a duplicate. The password is never logged.
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, SystemRole } from '@prisma/client';
import { PasswordService } from '../src/auth/password.service';

const logger = new Logger('SeedSuperAdmin');

const MIN_PASSWORD_LENGTH = 12;
const DEFAULT_POSITION = 'System Administrator';
const DEFAULT_DEPARTMENT = 'IT';

/**
 * Resolve an ACTIVE option by name, creating it if absent. Returns its id.
 *
 * The `deletedAt: null` filter matches the partial-unique index: a soft-deleted name is reusable, so
 * only an ACTIVE row of the same name counts as "already there".
 *
 * The two branches are spelled out rather than sharing a `delegate` variable: `Department` and
 * `PersonnelRole` have byte-identical but heavily overloaded Prisma delegates, and a union of the
 * two is not callable in TypeScript (`OptionsService` pays for the same fact with a hand-written
 * interface — overkill for a script).
 */
async function resolveOrCreateDepartment(
  prisma: PrismaClient,
  name: string,
): Promise<number> {
  const existing = await prisma.department.findFirst({
    where: { name, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.department.create({
    data: { name },
    select: { id: true },
  });
  logger.log(`Created department option. id=${created.id} name=${name}`);
  return created.id;
}

async function resolveOrCreatePersonnelRole(
  prisma: PrismaClient,
  name: string,
): Promise<number> {
  const existing = await prisma.personnelRole.findFirst({
    where: { name, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.personnelRole.create({
    data: { name },
    select: { id: true },
  });
  logger.log(`Created personnelRole option. id=${created.id} name=${name}`);
  return created.id;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  const email = (process.env.SEED_SUPER_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD ?? '';
  const position =
    (process.env.SEED_SUPER_ADMIN_POSITION ?? '').trim() || DEFAULT_POSITION;
  const department =
    (process.env.SEED_SUPER_ADMIN_DEPARTMENT ?? '').trim() ||
    DEFAULT_DEPARTMENT;

  if (!email || !password) {
    logger.error(
      'SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD must both be set in the environment.',
    );
    process.exitCode = 1;
    return;
  }

  // Never echo the password, not even its length beyond the policy threshold.
  if (password.length < MIN_PASSWORD_LENGTH) {
    logger.error(
      `SEED_SUPER_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    // The `deletedAt: null` filter is load-bearing: a soft-deleted SUPER_ADMIN grants nobody
    // access, so counting one would let a deleted row permanently lock the operator out of
    // re-seeding — the exact scenario this script exists to rescue. It deliberately does NOT
    // filter `isActive`: a *suspended* super admin still exists and is one flag-flip from working,
    // so the seed should refuse and let the operator reactivate them.
    const existing = await prisma.systemUser.count({
      where: { role: SystemRole.SUPER_ADMIN, deletedAt: null },
    });

    if (existing > 0 && !force) {
      logger.log(
        `A SUPER_ADMIN already exists (${existing} active). Refusing to seed. Pass --force to override.`,
      );
      return; // idempotent, non-error
    }

    const passwordHash = await new PasswordService().hash(password);

    // Resolve-or-create both options, so the script stays standalone and order-independent — it must
    // not require `options:seed` to have run first. NOT an `upsert`-on-name: active-name uniqueness
    // is a PARTIAL index (`WHERE deletedAt IS NULL`), which upsert cannot express. Mirrors
    // seed-options.ts's idempotent idiom exactly.
    const personnelRoleId = await resolveOrCreatePersonnelRole(
      prisma,
      position,
    );
    const departmentId = await resolveOrCreateDepartment(prisma, department);

    const user = await prisma.systemUser.upsert({
      where: { email },
      create: {
        email,
        passwordHash,
        firstName: 'EasyBook',
        lastName: '(Super Admin)',
        role: SystemRole.SUPER_ADMIN,
        personnelRoleId,
        departmentId,
        // EXPLICIT: the model default is `true`. The migration's backfill only covers rows that
        // already exist, so without this a FRESH database would brick the seeded super admin behind
        // a forced-reset screen demanding a temp password nobody was ever issued — the same lockout
        // AC-B6 exists to prevent, one step earlier.
        mustChangePassword: false,
        isActive: true,
        createdById: null,
      },
      // Restoration is the intended escape hatch, and it is what makes the permanent email burn
      // tolerable: the SAME row returns, preserving its createdById chain and everything it
      // created. A NEW row at that address stays forbidden forever. `lineUserId` is never touched,
      // and neither is `mustChangePassword` — a restore must not change a credential state.
      update: { deletedAt: null, isActive: true },
      select: { id: true, email: true, role: true },
    });

    logger.log(`Seeded SUPER_ADMIN. id=${user.id} email=${user.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  logger.error(
    `Seeding failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
