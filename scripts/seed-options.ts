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

/**
 * ⚠️ THESE TWO LISTS ARE THE PROTOTYPE'S, ROW FOR ROW —
 * `docs/prototypes/admin-portal/master_layout_prototype_v2.html`, the `ตัวเลือกบุคลากร` module.
 * They replaced an English placeholder set ('Computer Science', 'Teacher', …) that appeared in no
 * design at all, on 19 ส.ค. 2569.
 *
 * The prototype is the design authority, and these names are not decoration there: the
 * เจ้าหน้าที่ระบบ directory and the LINE registration screens both print them, and both are
 * REQUIRED FKs into these tables — so a name here that the design does not have describes a record
 * the product cannot show.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT: the two SYSTEM-RESERVED rows and the two TOMBSTONE rows. Only
 * `create-super-admin.ts` may write `isSystemReserved: true`, so this command must never contain
 * them — a row seeded here with the same NAME and no flag would be an ordinary, assignable option
 * that merely looks like the reserved one. That is the AC-X3 trap exactly: the flag is the
 * boundary, never the name.
 *
 * The order is the prototype's own (Thai collation). Nothing depends on it — the API sorts by name
 * — but keeping it makes the two files diffable by eye.
 */
const DEPARTMENTS: readonly string[] = [
  'กลุ่มสาระการเรียนรู้วิทยาศาสตร์และเทคโนโลยี',
  'ฝ่ายกิจการนักศึกษา',
  'ฝ่ายเทคโนโลยีสารสนเทศ',
  'ฝ่ายบริหารงานทั่วไป',
  'ฝ่ายวิชาการ',
  'ฝ่ายอาคารสถานที่',
  'วิทยาการคอมพิวเตอร์',
];

/**
 * Personnel roles — the LINE end-user's self-declared job title. NOT `SystemRole`.
 *
 * ⚠️ `ผู้ดูแลระบบ` IS AN ORDINARY ROW AND GRANTS NOTHING. It sits deliberately close to the
 * reserved `ผู้ดูแลระบบระดับสูง (System Administrator)` that the bootstrap script owns, and the
 * prototype keeps both for that reason: two names two words apart, separated only by a flag. Do not
 * "tidy" this one away because it looks privileged — it is a string on a row, and the AC-X3
 * cross-check in `test/options.e2e-spec.ts` exists because that confusion is typeable.
 *
 * ⚠️ `นักศึกษาฝึกประสบการณ์` softens SC-B1's "no student wording", and it comes from the prototype.
 * An intern posted to a school IS personnel — they hold a unit and a title like anyone else — so
 * the refocus's intent (this product does not serve students as end users) is intact. Flagged
 * rather than silently dropped: the rule and the design disagree on the surface, and the design won
 * because the PO owns it.
 */
const PERSONNEL_ROLES: readonly string[] = [
  'เจ้าหน้าที่',
  'นักการภารโรง',
  'นักศึกษาฝึกประสบการณ์',
  'บุคลากรทางการศึกษา',
  'ผู้ช่วยผู้อำนวยการ',
  'ผู้ดูแลระบบ',
  'ผู้อำนวยการ',
  'รองผู้อำนวยการ',
  'หัวหน้าฝ่าย',
  'อาจารย์',
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
