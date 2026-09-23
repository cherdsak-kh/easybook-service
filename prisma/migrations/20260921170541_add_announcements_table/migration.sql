-- CreateEnum
CREATE TYPE "AnnouncementFormat" AS ENUM ('TEXT', 'FLEX');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'SENT');

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL', 'DEPARTMENT');

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "format" "AnnouncementFormat" NOT NULL DEFAULT 'TEXT',
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "audience" "AnnouncementAudience" NOT NULL DEFAULT 'ALL',
    "departmentId" INTEGER,
    "sentAt" TIMESTAMP(3),
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_status_createdAt_idx" ON "announcements"("status", "createdAt");

-- CreateIndex
CREATE INDEX "announcements_createdAt_idx" ON "announcements"("createdAt");

-- CreateIndex
CREATE INDEX "announcements_departmentId_idx" ON "announcements"("departmentId");

-- CreateIndex
CREATE INDEX "announcements_createdById_idx" ON "announcements"("createdById");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "system_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
