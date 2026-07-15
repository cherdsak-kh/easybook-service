-- AlterEnum
ALTER TYPE "AppAccess" ADD VALUE 'UNREGISTERED';

-- AlterTable
ALTER TABLE "line_users" ALTER COLUMN "access" SET DEFAULT 'UNREGISTERED';

-- CreateTable
CREATE TABLE "line_user_registrations" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "studentStaffId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "line_user_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "line_user_registrations_lineUserId_key" ON "line_user_registrations"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "line_user_registrations_studentStaffId_key" ON "line_user_registrations"("studentStaffId");

-- CreateIndex
CREATE INDEX "line_user_registrations_deletedAt_idx" ON "line_user_registrations"("deletedAt");

-- AddForeignKey
ALTER TABLE "line_user_registrations" ADD CONSTRAINT "line_user_registrations_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "line_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
