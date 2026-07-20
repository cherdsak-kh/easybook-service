-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "isSystemReserved" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "personnel_roles" ADD COLUMN     "isSystemReserved" BOOLEAN NOT NULL DEFAULT false;
