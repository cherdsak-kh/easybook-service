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

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  const email = (process.env.SEED_SUPER_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD ?? '';
  const position = (process.env.SEED_SUPER_ADMIN_POSITION ?? '').trim() || DEFAULT_POSITION;
  const department =
    (process.env.SEED_SUPER_ADMIN_DEPARTMENT ?? '').trim() || DEFAULT_DEPARTMENT;

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

    const user = await prisma.systemUser.upsert({
      where: { email },
      create: {
        email,
        passwordHash,
        firstName: 'EasyBook',
        lastName: '(Super Admin)',
        role: SystemRole.SUPER_ADMIN,
        position,
        department,
        isActive: true,
        createdById: null,
      },
      // Restoration is the intended escape hatch, and it is what makes the permanent email burn
      // tolerable: the SAME row returns, preserving its createdById chain and everything it
      // created. A NEW row at that address stays forbidden forever. `lineUserId` is never touched.
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
