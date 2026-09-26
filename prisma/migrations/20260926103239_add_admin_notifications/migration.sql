-- CreateEnum
CREATE TYPE "AdminNotificationCategory" AS ENUM ('BOOKING', 'REGISTRATION', 'FEEDBACK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AdminNotificationTone" AS ENUM ('SKY', 'AMBER', 'ROSE', 'EMERALD', 'SLATE');

-- CreateEnum
CREATE TYPE "AdminNotificationTargetRole" AS ENUM ('ALL', 'ADMIN', 'SUPER_ADMIN');

-- CreateTable
CREATE TABLE "admin_notifications" (
    "id" TEXT NOT NULL,
    "category" "AdminNotificationCategory" NOT NULL,
    "code" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tone" "AdminNotificationTone" NOT NULL,
    "icon" TEXT NOT NULL,
    "actionUrl" TEXT,
    "actionLabel" TEXT,
    "targetRole" "AdminNotificationTargetRole" NOT NULL DEFAULT 'ALL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_notification_receipts" (
    "systemUserId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "admin_notification_receipts_pkey" PRIMARY KEY ("systemUserId","notificationId")
);

-- CreateIndex
CREATE INDEX "admin_notifications_createdAt_id_idx" ON "admin_notifications"("createdAt", "id");

-- CreateIndex
CREATE INDEX "admin_notifications_category_createdAt_idx" ON "admin_notifications"("category", "createdAt");

-- CreateIndex
CREATE INDEX "admin_notification_receipts_notificationId_idx" ON "admin_notification_receipts"("notificationId");

-- AddForeignKey
ALTER TABLE "admin_notification_receipts" ADD CONSTRAINT "admin_notification_receipts_systemUserId_fkey" FOREIGN KEY ("systemUserId") REFERENCES "system_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_notification_receipts" ADD CONSTRAINT "admin_notification_receipts_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "admin_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
