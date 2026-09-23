-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('ISSUE', 'FEEDBACK');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "feedbacks" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "FeedbackType" NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "venueId" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "photos" TEXT[],
    "status" "FeedbackStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feedbacks_code_key" ON "feedbacks"("code");

-- CreateIndex
CREATE INDEX "feedbacks_status_createdAt_idx" ON "feedbacks"("status", "createdAt");

-- CreateIndex
CREATE INDEX "feedbacks_type_createdAt_idx" ON "feedbacks"("type", "createdAt");

-- CreateIndex
CREATE INDEX "feedbacks_createdAt_idx" ON "feedbacks"("createdAt");

-- CreateIndex
CREATE INDEX "feedbacks_lineUserId_idx" ON "feedbacks"("lineUserId");

-- CreateIndex
CREATE INDEX "feedbacks_venueId_idx" ON "feedbacks"("venueId");

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_lineUserId_fkey" FOREIGN KEY ("lineUserId") REFERENCES "line_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
