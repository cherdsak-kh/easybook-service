-- Non-destructive delta (SC-2, feature 20260714_1742_line_user_registration):
--   1. Rename studentStaffId -> staffId (preserves data + the unique index).
--   2. Replace free-text department/role with required FK references into two new admin-curated
--      option tables (Department, PersonnelRole), each soft-deleted with a PARTIAL unique index.
-- Hand-authored (`--create-only` style) so the rename is a RENAME COLUMN, not a destructive
-- DROP+ADD, and so the partial unique indexes (which the Prisma DSL cannot express) are included.
-- Does NOT edit the shipped 20260714112936_add_line_user_registration migration.

-- Rename staffId (SC-2.1 / Q1). The RENAME INDEX keeps the constraint name aligned with what Prisma
-- expects for `staffId @unique`, so a subsequent migrate/diff sees no drift on this column.
ALTER TABLE "line_user_registrations" RENAME COLUMN "studentStaffId" TO "staffId";
ALTER INDEX "line_user_registrations_studentStaffId_key" RENAME TO "line_user_registrations_staffId_key";

-- Free-text department/role -> required FK columns (SC-2.4 / Q4). The registration table is empty
-- (verified: 0 rows before this migration), so `ADD COLUMN ... NOT NULL` needs no default/backfill.
ALTER TABLE "line_user_registrations" DROP COLUMN "department",
DROP COLUMN "role",
ADD COLUMN     "departmentId" TEXT NOT NULL,
ADD COLUMN     "personnelRoleId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personnel_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "personnel_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_deletedAt_idx" ON "departments"("deletedAt");

-- CreateIndex
CREATE INDEX "personnel_roles_deletedAt_idx" ON "personnel_roles"("deletedAt");

-- PARTIAL unique indexes on active names (SC-2.3 / Q2). The Prisma DSL cannot express a partial
-- unique constraint, so `name` stays un-@unique in schema.prisma and this constraint lives only
-- here. Effect: at most one NON-DELETED row per name; a soft-deleted name is reusable. A create/
-- rename colliding with an ACTIVE name raises P2002 -> 409 NAME_TAKEN.
CREATE UNIQUE INDEX "departments_name_active_key" ON "departments"("name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "personnel_roles_name_active_key" ON "personnel_roles"("name") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "line_user_registrations_departmentId_idx" ON "line_user_registrations"("departmentId");

-- CreateIndex
CREATE INDEX "line_user_registrations_personnelRoleId_idx" ON "line_user_registrations"("personnelRoleId");

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_personnelRoleId_fkey" FOREIGN KEY ("personnelRoleId") REFERENCES "personnel_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
