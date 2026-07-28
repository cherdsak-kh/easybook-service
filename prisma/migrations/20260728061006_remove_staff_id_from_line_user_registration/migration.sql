/*
  Warnings:

  - You are about to drop the column `staffId` on the `line_user_registrations` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "line_user_registrations_staffId_key";

-- AlterTable
ALTER TABLE "line_user_registrations" DROP COLUMN "staffId";
