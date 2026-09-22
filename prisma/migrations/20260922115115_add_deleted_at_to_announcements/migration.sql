-- AlterTable
ALTER TABLE "announcements" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "announcements_deletedAt_createdAt_idx" ON "announcements"("deletedAt", "createdAt");
