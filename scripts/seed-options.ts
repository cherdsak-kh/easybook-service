/**
 * Registration option seed — run: `npm run options:seed`
 *
 * Seeds the admin-curated `Department` and `PersonnelRole` option tables so the LINE registration
 * form is not empty on day one. Admins curate the lists afterward via the admin CRUD endpoints.
 *
 * A SEED SCRIPT, NOT A MIGRATION (project convention: migrations are DDL-only; seeds are idempotent
 * scripts like `create-super-admin.ts`). Safe to re-run.
 *
 * Idempotent: a partial-unique `name` index means an `upsert`-on-name is not expressible, so for each
 * starter name we `findFirst({ name, deletedAt: null })` and `create` only if absent. Existing rows
 * (active or soft-deleted) are never touched. Logs counts only — these tables hold no PII.
 *
 * `PersonnelRole` is the LINE end-user's self-declared role — it is NOT `SystemRole` (back-office
 * RBAC). No "student" wording, per the educational-personnel refocus (SC-B1).
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const logger = new Logger('SeedOptions');

/** Educational-personnel focus; admins curate afterward. */
const DEPARTMENTS: readonly string[] = [
  'Computer Science',
  'Mathematics',
  'Physics',
  'Chemistry',
  'Biology',
  'Engineering',
  'Business Administration',
  "Registrar's Office",
  'Student Affairs',
  'IT Services',
];

/** Personnel roles (NOT SystemRole; no "student" wording). */
const PERSONNEL_ROLES: readonly string[] = [
  'Teacher',
  'Lecturer',
  'Support Staff',
  'Administrative Staff',
  'Technician',
  'Director',
];

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    let departmentsCreated = 0;
    for (const name of DEPARTMENTS) {
      // The `deletedAt: null` filter matches the partial-unique index: a soft-deleted name is
      // reusable, so we only skip an ACTIVE row of the same name.
      const existing = await prisma.department.findFirst({
        where: { name, deletedAt: null },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.department.create({ data: { name } });
      departmentsCreated += 1;
    }

    let rolesCreated = 0;
    for (const name of PERSONNEL_ROLES) {
      const existing = await prisma.personnelRole.findFirst({
        where: { name, deletedAt: null },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.personnelRole.create({ data: { name } });
      rolesCreated += 1;
    }

    logger.log(
      `Seeded options. departmentsCreated=${departmentsCreated}/${DEPARTMENTS.length} personnelRolesCreated=${rolesCreated}/${PERSONNEL_ROLES.length} (existing rows left untouched).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  logger.error(
    `Seeding options failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
