-- CreateEnum
CREATE TYPE "RichMenuType" AS ENUM ('TYPE_1', 'TYPE_2');

-- CreateEnum
CREATE TYPE "AppAccess" AS ENUM ('PENDING', 'ALLOWED', 'BLOCKED');

-- CreateTable
CREATE TABLE "line_users" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "pictureUrl" TEXT,
    "statusMessage" TEXT,
    "language" TEXT,
    "richMenuType" "RichMenuType" NOT NULL DEFAULT 'TYPE_1',
    "access" "AppAccess" NOT NULL DEFAULT 'PENDING',
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "line_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "line_users_lineUserId_key" ON "line_users"("lineUserId");

-- CreateIndex
CREATE INDEX "line_users_deletedAt_idx" ON "line_users"("deletedAt");
