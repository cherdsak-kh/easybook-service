-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RichMenuType" AS ENUM ('TYPE_1', 'TYPE_2');

-- CreateEnum
CREATE TYPE "AppAccess" AS ENUM ('UNREGISTERED', 'PENDING', 'ALLOWED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'STAFF');

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
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "staffId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
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

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personnel_roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "personnel_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "SystemRole" NOT NULL DEFAULT 'STAFF',
    "position" TEXT NOT NULL,
    "department" TEXT NOT NULL,
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
CREATE UNIQUE INDEX "line_user_registrations_lineUserId_key" ON "line_user_registrations"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "line_user_registrations_staffId_key" ON "line_user_registrations"("staffId");

-- CreateIndex
CREATE INDEX "line_user_registrations_deletedAt_idx" ON "line_user_registrations"("deletedAt");

-- CreateIndex
CREATE INDEX "line_user_registrations_departmentId_idx" ON "line_user_registrations"("departmentId");

-- CreateIndex
CREATE INDEX "line_user_registrations_personnelRoleId_idx" ON "line_user_registrations"("personnelRoleId");

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

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "line_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_personnelRoleId_fkey" FOREIGN KEY ("personnelRoleId") REFERENCES "personnel_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "system_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_users" ADD CONSTRAINT "system_users_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "line_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PARTIAL unique indexes on active names (SC-2.3 / Q2). The Prisma DSL cannot express a partial
-- unique constraint, so `name` stays un-@unique in schema.prisma and this constraint lives only
-- here (carried verbatim across the migration squash). Effect: at most one NON-DELETED row per
-- name; a soft-deleted name is reusable. A create/rename colliding with an ACTIVE name raises
-- P2002 -> 409 NAME_TAKEN.
CREATE UNIQUE INDEX "departments_name_active_key" ON "departments"("name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "personnel_roles_name_active_key" ON "personnel_roles"("name") WHERE "deletedAt" IS NULL;
