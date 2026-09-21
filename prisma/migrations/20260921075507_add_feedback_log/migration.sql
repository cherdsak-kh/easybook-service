-- CreateTable
CREATE TABLE "feedback_logs" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "status" "FeedbackStatus" NOT NULL,
    "note" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_logs_feedbackId_createdAt_idx" ON "feedback_logs"("feedbackId", "createdAt");

-- CreateIndex
CREATE INDEX "feedback_logs_authorId_idx" ON "feedback_logs"("authorId");

-- AddForeignKey
ALTER TABLE "feedback_logs" ADD CONSTRAINT "feedback_logs_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedbacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_logs" ADD CONSTRAINT "feedback_logs_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "system_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
