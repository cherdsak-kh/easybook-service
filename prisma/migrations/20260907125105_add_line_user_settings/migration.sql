-- CreateTable
CREATE TABLE "line_user_settings" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "notifications" JSONB NOT NULL DEFAULT '{"announcements":true,"decisions":true,"reminders":true}',
    "preferences" JSONB,
    "privacy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "line_user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "line_user_settings_lineUserId_key" ON "line_user_settings"("lineUserId");

-- AddForeignKey
ALTER TABLE "line_user_settings" ADD CONSTRAINT "line_user_settings_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "line_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
