-- CreateEnum
CREATE TYPE "LoginEventStatus" AS ENUM ('SUCCESS', 'FAILED_BAD_PASSWORD', 'FORCE_REVOKED');

-- CreateTable
CREATE TABLE "system_user_login_logs" (
    "id" TEXT NOT NULL,
    "systemUserId" TEXT NOT NULL,
    "status" "LoginEventStatus" NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sessionRef" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_user_login_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_user_login_logs_systemUserId_createdAt_id_idx" ON "system_user_login_logs"("systemUserId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "system_user_login_logs_createdAt_idx" ON "system_user_login_logs"("createdAt");

-- CreateIndex
CREATE INDEX "system_user_login_logs_actorId_idx" ON "system_user_login_logs"("actorId");

-- AddForeignKey
ALTER TABLE "system_user_login_logs" ADD CONSTRAINT "system_user_login_logs_systemUserId_fkey" FOREIGN KEY ("systemUserId") REFERENCES "system_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_user_login_logs" ADD CONSTRAINT "system_user_login_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "system_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
