-- AlterEnum
ALTER TYPE "AppAccess" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "line_users" ADD COLUMN     "rejectionReason" TEXT;
