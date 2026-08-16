-- CreateEnum
CREATE TYPE "RichMenuType" AS ENUM ('TYPE_1', 'TYPE_2');

-- CreateEnum
CREATE TYPE "AppAccess" AS ENUM ('UNREGISTERED', 'PENDING', 'ALLOWED', 'BLOCKED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VIEWER');

-- CreateTable
CREATE TABLE "line_users" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "pictureUrl" TEXT,
    "statusMessage" TEXT,
    "language" TEXT,
    "richMenuType" "RichMenuType" NOT NULL DEFAULT 'TYPE_1',
    "access" "AppAccess" NOT NULL DEFAULT 'UNREGISTERED',
    "rejectionReason" TEXT,
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "line_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "line_user_registrations" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneDigits" TEXT NOT NULL,
    "departmentId" INTEGER NOT NULL,
    "personnelRoleId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "line_user_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "isSystemReserved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personnel_roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "isSystemReserved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "personnel_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "SystemRole" NOT NULL DEFAULT 'VIEWER',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" INTEGER NOT NULL,
    "personnelRoleId" INTEGER NOT NULL,
    "phoneNumber" TEXT,
    "profilePictureUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "lineUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "line_users_lineUserId_key" ON "line_users"("lineUserId");

-- CreateIndex
CREATE INDEX "line_users_deletedAt_idx" ON "line_users"("deletedAt");

-- CreateIndex
CREATE INDEX "line_users_registeredAt_idx" ON "line_users"("registeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "line_user_registrations_lineUserId_key" ON "line_user_registrations"("lineUserId");

-- CreateIndex
CREATE INDEX "line_user_registrations_deletedAt_idx" ON "line_user_registrations"("deletedAt");

-- CreateIndex
CREATE INDEX "line_user_registrations_departmentId_idx" ON "line_user_registrations"("departmentId");

-- CreateIndex
CREATE INDEX "line_user_registrations_personnelRoleId_idx" ON "line_user_registrations"("personnelRoleId");

-- CreateIndex
CREATE INDEX "line_user_registrations_phoneDigits_idx" ON "line_user_registrations"("phoneDigits");

-- CreateIndex
CREATE INDEX "line_user_registrations_lastName_firstName_idx" ON "line_user_registrations"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "line_user_registrations_createdAt_idx" ON "line_user_registrations"("createdAt");

-- CreateIndex
CREATE INDEX "departments_deletedAt_idx" ON "departments"("deletedAt");

-- CreateIndex
CREATE INDEX "personnel_roles_deletedAt_idx" ON "personnel_roles"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "system_users_email_key" ON "system_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "system_users_lineUserId_key" ON "system_users"("lineUserId");

-- CreateIndex
CREATE INDEX "system_users_createdById_idx" ON "system_users"("createdById");

-- CreateIndex
CREATE INDEX "system_users_departmentId_idx" ON "system_users"("departmentId");

-- CreateIndex
CREATE INDEX "system_users_personnelRoleId_idx" ON "system_users"("personnelRoleId");

-- CreateIndex
CREATE INDEX "system_users_role_idx" ON "system_users"("role");

-- CreateIndex
CREATE INDEX "system_users_isActive_idx" ON "system_users"("isActive");

-- CreateIndex
CREATE INDEX "system_users_lastName_firstName_idx" ON "system_users"("lastName", "firstName");

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "line_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_personnelRoleId_fkey" FOREIGN KEY ("personnelRoleId") REFERENCES "personnel_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_personnelRoleId_fkey" FOREIGN KEY ("personnelRoleId") REFERENCES "personnel_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "system_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "line_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- PARTIAL unique indexes on ACTIVE names (SC-2.3 / Q2).
--
-- HAND-WRITTEN, AND THEY MUST STAY THAT WAY. The Prisma DSL cannot express a partial unique
-- constraint, so `name` is deliberately NOT `@unique` in schema.prisma and this rule lives only
-- here. `prisma migrate dev` will never regenerate these from the schema: they survived the
-- 2026-08-16 squash only because the squash went looking for them.
--
-- Effect: at most ONE non-deleted row per name, while a soft-deleted name is REUSABLE. The option
-- service depends on exactly this — it creates write-then-catch and turns the resulting P2002 into
-- a 409. Without the index there is no P2002, no 409, and duplicate active options appear in a
-- dropdown with no way to tell them apart.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "departments_name_active_key" ON "departments"("name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "personnel_roles_name_active_key" ON "personnel_roles"("name") WHERE "deletedAt" IS NULL;
